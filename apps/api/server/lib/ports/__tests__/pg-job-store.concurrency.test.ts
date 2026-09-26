import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { databaseConfig } from "../../db/database-config.js";
import { pgClient, poolOptions } from "../../db/pg-client.js";
import { loadMigrations, migrate } from "../../db/migrate.js";
import type { SqlClient } from "../../db/sql-client.js";
import { JobCapacityError, MAX_JOBS } from "../fs-job-store.js";
import { PgJobStore } from "../pg-job-store.js";

/**
 * PGlite (every other database test) is one connection: it can serialise a
 * "second claim" call, but it cannot make two claims arrive at Postgres at the
 * same instant, which is the one thing D171's partial-unique-index claim exists
 * to survive. This file is the proof against a real server, over an actual
 * two-connection pool — skipped unless `TEST_DATABASE_URL` is set (CI's
 * `postgres:17` service; `.github/workflows/ci.yml`), never against the
 * owner's Aiven service.
 *
 * It owns a schema it creates and drops, so it can run beside every other
 * test's own database (or its own re-run) without clashing on `job`, `org` or
 * `schema_migrations`.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("PgJobStore.acquireJob races two real connections (PT-6a)", () => {
  const schema = `pt6a_test_${randomUUID().replaceAll("-", "_")}`;
  let db: SqlClient;

  beforeAll(async () => {
    const config = databaseConfig({ url, poolMax: "2" }, () => {
      throw new Error("a local TEST_DATABASE_URL needs no CA");
    });
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

  test("exactly one of two concurrent claims acquires; the other adopts its handle", async () => {
    const store = new PgJobStore(db, "local");
    const campaignId = `race-${randomUUID()}`;
    const lapsedId = `lapsed-${randomUUID()}`;
    // A lapsed lease already held for this campaign: both racing claims must
    // reap it before either can insert its own row, which is exactly the path
    // that a sequential (single-connection) test cannot exercise.
    await db.query(
      `insert into job (id, org_id, campaign_id, status, lease_expires_at, heartbeat_at)
       values ($1, $2, $3, 'running', now() - interval '1 second', now())`,
      [lapsedId, "local", campaignId],
    );

    const [a, b] = await Promise.all([store.acquireJob(campaignId), store.acquireJob(campaignId)]);
    const outcomes = [a, b];
    const acquired = outcomes.filter((o) => o.acquired);
    const refused = outcomes.filter((o) => !o.acquired);
    expect(acquired).toHaveLength(1);
    expect(refused).toHaveLength(1);

    const winnerId = acquired[0]!.acquired ? acquired[0]!.jobId : undefined;
    const loserSaw = refused[0]!.acquired ? undefined : refused[0]!.runningJobId;
    expect(loserSaw).toBe(winnerId);
    expect(winnerId).not.toBe(lapsedId);

    const { rows } = await db.query<{ status: string }>("select status from job where id = $1", [
      lapsedId,
    ]);
    expect(rows[0]).toEqual({ status: "failed" });
  });

  test("a fresh campaign under real concurrency still admits only one claim", async () => {
    const store = new PgJobStore(db, "local");
    const campaignId = `fresh-${randomUUID()}`;
    const [a, b] = await Promise.all([store.acquireJob(campaignId), store.acquireJob(campaignId)]);
    const acquiredCount = [a, b].filter((o) => o.acquired).length;
    expect(acquiredCount).toBe(1);
  });

  test("two DISTINCT campaigns racing at MAX_JOBS-1 admit exactly one under real concurrency (finding 3)", async () => {
    // Without the per-org advisory lock, both connections can read the same
    // `count(*) < MAX_JOBS` snapshot before either commits its insert, and both
    // admit — the count-then-insert race this test exists to close. Two
    // DISTINCT campaigns, so neither claim can be the other's incumbent: the
    // only thing that can refuse one is capacity.
    const store = new PgJobStore(db, "local");
    await store.clear();
    for (let i = 0; i < MAX_JOBS - 1; i++) {
      await db.query(
        `insert into job (id, org_id, campaign_id, status, lease_expires_at, heartbeat_at)
         values ($1, $2, $3, 'running', now() + interval '60 seconds', now())`,
        [`filler-${i}`, "local", `filler-camp-${i}`],
      );
    }
    const campA = `distinct-a-${randomUUID()}`;
    const campB = `distinct-b-${randomUUID()}`;
    const results = await Promise.allSettled([store.acquireJob(campA), store.acquireJob(campB)]);
    const admitted = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof store.acquireJob>>> =>
        r.status === "fulfilled" && r.value.acquired,
    );
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(admitted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toBeInstanceOf(JobCapacityError);
  });

  test("a queued row blocks a second enqueue under real concurrency (new unique index, PT-6b1)", async () => {
    // Its own org: earlier tests in this file fill `local` up to MAX_JOBS, and
    // capacity is per org, so sharing it would fail the enqueue for capacity.
    const orgId = `queued-race-${randomUUID().slice(0, 18)}`;
    await db.query("insert into org (id, name) values ($1, $2)", [orgId, "Queued race"]);
    const store = new PgJobStore(db, orgId);
    const campaignId = `queued-race-${randomUUID()}`;

    const [a, b] = await Promise.all([store.enqueueJob(campaignId), store.enqueueJob(campaignId)]);
    const outcomes = [a, b];
    const acquired = outcomes.filter((o) => o.acquired);
    const refused = outcomes.filter((o) => !o.acquired);
    expect(acquired).toHaveLength(1);
    expect(refused).toHaveLength(1);

    const winnerId = acquired[0]!.acquired ? acquired[0]!.jobId : undefined;
    const loserSaw = refused[0]!.acquired ? undefined : refused[0]!.runningJobId;
    expect(loserSaw).toBe(winnerId);

    const { rows } = await db.query<{ status: string }>("select status from job where id = $1", [
      winnerId,
    ]);
    expect(rows[0]?.status).toBe("queued");
  });
});
