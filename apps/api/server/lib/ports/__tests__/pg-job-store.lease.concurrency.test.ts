import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { testServerConfig } from "../../db/__tests__/test-server-config.js";
import { pgClient, poolOptions } from "../../db/pg-client.js";
import { loadMigrations, migrate } from "../../db/migrate.js";
import type { SqlClient } from "../../db/sql-client.js";
import { JobLeaseLostError, LEASE_MS, PgJobStore } from "../pg-job-store.js";

/**
 * Lease expiry against a real server (PT-6a DoD item 5, section 6 item 5:
 * "Two workers never run one campaign at once, and a killed worker's lease
 * expires, both asserted against the real database in CI"). The fenced writes
 * (`heartbeat`, `progressJob`, `completeJob`) gate on
 * `status = 'running' and lease_expires_at > now()`, so a lapsed lease is
 * refused even before any reaper writes `'failed'` — the window no
 * single-connection test can open, because PGlite is one connection and a
 * second worker's claim (the reaper) must arrive on a different one.
 *
 * This file is the proof against a real server, over an actual two-connection
 * pool — skipped unless `TEST_DATABASE_URL` is set (CI's `postgres:17` service;
 * `.github/workflows/ci.yml`), never against the owner's Aiven service.
 *
 * It owns a schema it creates and drops, so it can run beside every other
 * test's own database (or its own re-run) without clashing on `job`, `org` or
 * `schema_migrations`.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("PgJobStore lease expiry across two real connections (PT-6a)", () => {
  const schema = `pt6a_lease_test_${randomUUID().replaceAll("-", "_")}`;
  let db: SqlClient;

  beforeAll(async () => {
    const config = testServerConfig({ url, poolMax: "2" }, "TEST_DATABASE_URL");
    // Every connection in the pool starts in this schema (a libpq startup
    // option, applied per connection — `search_path` cannot be set once for a
    // pool the way a single session could). `CREATE SCHEMA` itself is
    // unaffected by search_path, since it names the schema explicitly, so this
    // is safe to run before the schema exists.
    db = pgClient(
      config,
      (cfg) => new pg.Pool({ ...poolOptions(cfg), options: `-c search_path=${schema}` }),
    );
    await db.query(`create schema if not exists "${schema}"`);
    // 0001_org.sql seeds the "local" org itself; nothing to add here.
    await migrate(db, await loadMigrations());
  });

  afterAll(async () => {
    await db.query(`drop schema if exists "${schema}" cascade`);
    await db.end();
  });

  /** A `timestamptz` read back as epoch milliseconds, so comparisons are exact. */
  async function leaseEpoch(jobId: string): Promise<number> {
    const { rows } = await db.query<{ ms: string }>(
      `select extract(epoch from lease_expires_at) * 1000 as ms from job where id = $1`,
      [jobId],
    );
    return Number(rows[0]!.ms);
  }

  async function requireOne(sql: string, params: readonly unknown[]): Promise<void> {
    const { rows } = await db.query(sql, params);
    // A missed setup row must fail here, not surface later as a puzzling
    // assertion about a row that was never updated.
    expect(rows.length).toBe(1);
  }

  test("a silent worker's lease expires before any reaper runs", async () => {
    const store = new PgJobStore(db, "local");
    const campaignId = `lease-silent-${randomUUID()}`;
    await db.query(`insert into campaign (org_id, slug) values ('local', $1)`, [campaignId]);

    const claim = await store.acquireJob(campaignId);
    if (!claim.acquired) throw new Error("expected the claim to acquire");
    const jobId = claim.jobId;

    // Simulate worker death: the lease lapses, but nothing has reaped the row.
    await requireOne(
      `update job set lease_expires_at = now() - interval '1 second' where id = $1 returning id`,
      [jobId],
    );
    const expiredAt = await leaseEpoch(jobId);

    // A late heartbeat is upkeep, not a claim: it must not renew a lease that
    // has already run out, and it must not settle the row either.
    await store.heartbeat(jobId);
    expect(await leaseEpoch(jobId)).toBeLessThanOrEqual(expiredAt);
    const { rows: statusRows } = await db.query<{ status: string }>(
      "select status from job where id = $1",
      [jobId],
    );
    expect(statusRows[0]).toEqual({ status: "running" });

    // Both fenced writes refuse the lapsed lease and leave the row untouched.
    await expect(store.progressJob(jobId, 1, 2)).rejects.toThrow(JobLeaseLostError);
    await expect(
      store.completeJob(jobId, { halted: false, assets: [], log: null }),
    ).rejects.toThrow(JobLeaseLostError);
    const { rows: afterRows } = await db.query<{ status: string }>(
      "select status from job where id = $1",
      [jobId],
    );
    expect(afterRows[0]).toEqual({ status: "running" });
  });

  test("a second worker acquires and reaps; the first worker's late writes fail and do not touch its row", async () => {
    const store = new PgJobStore(db, "local");
    const campaignId = `lease-reap-${randomUUID()}`;
    await db.query(`insert into campaign (org_id, slug) values ('local', $1)`, [campaignId]);

    const first = await store.acquireJob(campaignId);
    if (!first.acquired) throw new Error("expected the first claim to acquire");
    const job1 = first.jobId;
    await requireOne(
      `update job set lease_expires_at = now() - interval '1 second' where id = $1 returning id`,
      [job1],
    );

    // The second claim runs the reaper on its way in: the lapsed row is
    // settled to 'failed' and the new claim gets its own row.
    const second = await store.acquireJob(campaignId);
    if (!second.acquired) throw new Error("expected the second claim to acquire");
    const job2 = second.jobId;
    expect(job2).not.toBe(job1);

    const { rows } = await db.query<{ id: string; status: string; settled_at: string | null }>(
      "select id, status, settled_at from job where id in ($1, $2) order by id",
      [job1, job2],
    );
    expect(rows).toHaveLength(2);
    const reaped = rows.find((r) => r.id === job1);
    const fresh = rows.find((r) => r.id === job2);
    expect(reaped).toMatchObject({ status: "failed" });
    expect(reaped?.settled_at).not.toBeNull();
    expect(fresh).toMatchObject({ status: "running" });
    const settledAt = reaped?.settled_at ?? null;

    // A heartbeat aimed at the settled row is a no-op: it must not revive it
    // or move its settled_at.
    await store.heartbeat(job1);
    const { rows: afterHeartbeat } = await db.query<{
      status: string;
      settled_at: string | null;
    }>("select status, settled_at from job where id = $1", [job1]);
    expect(afterHeartbeat[0]).toEqual({ status: "failed", settled_at: settledAt });

    // And a late completion is refused, touching neither row.
    await expect(store.completeJob(job1, { halted: false, assets: [], log: null })).rejects.toThrow(
      JobLeaseLostError,
    );
    const { rows: afterComplete } = await db.query<{ id: string; status: string }>(
      "select id, status from job where id in ($1, $2)",
      [job1, job2],
    );
    expect(afterComplete.find((r) => r.id === job1)).toMatchObject({ status: "failed" });
    expect(afterComplete.find((r) => r.id === job2)).toMatchObject({ status: "running" });
  });

  test("a live heartbeat keeps the lease and a second claim sees the incumbent", async () => {
    const store = new PgJobStore(db, "local");
    const campaignId = `lease-live-${randomUUID()}`;
    await db.query(`insert into campaign (org_id, slug) values ('local', $1)`, [campaignId]);

    const claim = await store.acquireJob(campaignId);
    if (!claim.acquired) throw new Error("expected the claim to acquire");
    const jobId = claim.jobId;

    // Push the lease to the edge of lapsing, then heartbeat: the renewal is
    // a full LEASE_MS from the heartbeat, not from the old expiry.
    await requireOne(
      `update job set lease_expires_at = now() + interval '5 seconds'
       where id = $1 returning extract(epoch from lease_expires_at) * 1000 as ms`,
      [jobId],
    );
    const nearExpiry = await leaseEpoch(jobId);
    await store.heartbeat(jobId);
    const after = await leaseEpoch(jobId);
    // LEASE_MS is 60_000 ms: a renewed lease sits a full term past the
    // heartbeat, well beyond the ~5 seconds the row was left with.
    expect(after - nearExpiry).toBeGreaterThan(30_000);

    // The live lease is the incumbent: a second claim is refused with its id.
    await expect(store.acquireJob(campaignId)).resolves.toEqual({
      acquired: false,
      runningJobId: jobId,
    });
    expect(LEASE_MS).toBe(60_000);
  });
});
