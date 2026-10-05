import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import pg from "pg";
import { databaseConfig } from "../../db/database-config.js";
import { pgClient, poolOptions } from "../../db/pg-client.js";
import { loadMigrations, migrate } from "../../db/migrate.js";
import type { SqlClient, SqlQuery } from "../../db/sql-client.js";
import { CampaignGoneError } from "../job-store.port.js";
import { PgJobStore } from "../pg-job-store.js";

/**
 * D235's claim guard (PT-9c): a live `for share` on the campaign row that the
 * claim takes inside `acquireJob`/`enqueueJob`, against TWO REAL CONNECTIONS.
 *
 * PGlite is one connection: it can prove the guard throws, but it cannot prove
 * the guard LOCKS — two statements on one connection are serialised by the
 * connection itself, so a "second actor" over PGlite races nothing. This file
 * is the proof over a real server, `poolMax: "2"`, where the tombstone and the
 * claim each take a connection and the `for share` / `for update` conflict is
 * real. Skipped unless `TEST_DATABASE_URL` is set (CI's `postgres:17` service) —
 * never against the owner's Aiven service, and never against `TEST_PG_URL`
 * (that names the per-test clone harness, which has no CREATE on a shared
 * database the way `create schema` here needs).
 *
 * **`TEST_DATABASE_URL` and not `TEST_PG_URL` is also why this file is NOT in
 * the lane's manifest.** CI's manifest-replay step runs before the `Test` step
 * that exports `TEST_DATABASE_URL`, so a manifest entry witnessed only here
 * would replay with no real server and turn CI red on a claim the gate cannot
 * check. The lane's verifiable mutation lives in `pg-job-store.test.ts` instead.
 *
 * It owns a schema it creates and drops, so it runs beside every other test's
 * own database without clashing on `campaign`, `job`, `org` or
 * `schema_migrations`.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)(
  "PgJobStore's campaign claim guard locks with a concurrent tombstone (PT-9c, D235)",
  () => {
    const schema = `pt9c_test_${randomUUID().replaceAll("-", "_")}`;
    let db: SqlClient;

    beforeAll(async () => {
      const config = databaseConfig({ url, poolMax: "2" }, () => {
        throw new Error("a local TEST_DATABASE_URL needs no CA");
      });
      // `poolMax: "2"` is the binding constraint, not a tuning choice: one
      // connection is held by the claim (or tombstone) transaction for the whole
      // of the interleaving, so the other connection is the only other actor that
      // can exist.
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

    const sleep = (ms: number): Promise<"timeout"> =>
      new Promise((resolve) => {
        setTimeout(() => resolve("timeout"), ms);
      });

    test("a tombstone committed first makes the claim refuse: the claim waits on the open tombstone", async () => {
      const store = new PgJobStore(db, "local");
      const slug = `pt9c-a-${randomUUID().slice(0, 8)}`;
      // Seed a LIVE campaign, capturing its uuid id. This case passes the SLUG to
      // enqueueJob (so the claim resolves it through the slug branch's `for share`),
      // while B's update targets the row by `id` — hence both values.
      const { rows: campaigns } = await db.query<{ id: string }>(
        `insert into campaign (org_id, slug) values ('local', $1) returning id`,
        [slug],
      );
      const campaignId = campaigns[0]!.id;

      let announce!: () => void;
      const announced = new Promise<void>((resolve) => {
        announce = resolve;
      });
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      // B (the tombstone) launches FIRST, unawaited, on the pool's second
      // connection. A bare `update` (never `db.query("begin")`: a pool client pins
      // no connection, so two bare statements can land on two different
      // connections and never share a transaction) acquires the row's ROW
      // EXCLUSIVE and holds it until this transaction commits — that is the lock
      // this test proves is taken, so the claim must be the one to wait.
      const b = db.transaction(async (tx) => {
        await tx.query(`update campaign set deleted_at = now() where id = $1`, [campaignId]);
        announce();
        await released;
      });
      b.catch(() => undefined);
      await announced;

      // A (the claim) launches only after B holds the row; it blocks on its own
      // `for share` against B's open update. A throws CampaignGoneError once B
      // commits and the row reads as tombstoned.
      const a = store.enqueueJob(slug);
      a.catch(() => undefined);
      const outcome = await Promise.race([
        a.then(
          () => "settled",
          () => "settled",
        ),
        sleep(300),
      ]);
      release();
      await Promise.allSettled([a, b]);

      expect(outcome).toBe("timeout");
      await expect(a).rejects.toBeInstanceOf(CampaignGoneError);
      // No job row was ever inserted: a thrown error alone does not prove nothing
      // was written, and the lock proof above is what makes this assertion land
      // after the transaction has actually committed.
      const { rows: count } = await db.query<{ n: number }>(
        `select count(*)::int as n from job where campaign_id = $1`,
        [campaignId],
      );
      expect(count[0]!.n).toBe(0);
    });

    test("a claim committed first makes the tombstone wait: the campaign row stays shared until the job row is written", async () => {
      const slug = `pt9c-b-${randomUUID().slice(0, 8)}`;
      const { rows: campaigns } = await db.query<{ id: string }>(
        `insert into campaign (org_id, slug) values ('local', $1) returning id`,
        [slug],
      );
      const campaignId = campaigns[0]!.id;

      // The pause wrapper holds A's transaction open AFTER campaignClaimable's
      // `for share` has run (so the campaign row is genuinely locked) but BEFORE
      // the `insert into job` — exactly the gap a concurrent tombstone must wait
      // behind. Mirrors PT-9d's pause wrapper: the lock is taken by the store's
      // own SQL, not by a lock statement this test issues, so dropping `for share`
      // is what turns this green (the mutant must leave it red).
      let announceLock!: () => void;
      const lockTaken = new Promise<void>((resolve) => {
        announceLock = resolve;
      });
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let paused = false;
      const wrapped: SqlClient = {
        ...db,
        transaction: (work) =>
          db.transaction((tx) => {
            const intercept: SqlQuery = {
              ...tx,
              query: async <R>(text: string, params?: readonly unknown[]) => {
                // The first `insert into job` arrives AFTER the campaign's `for
                // share` select has already returned — at that point the row is
                // locked by this transaction and only the write is held back.
                if (!paused && text.includes("insert into job")) {
                  paused = true;
                  announceLock();
                  await released;
                }
                return tx.query<R>(text, params);
              },
            };
            return work(intercept);
          }),
      };
      const store = new PgJobStore(wrapped, "local");

      // A (the claim) by uuid text — exercises the uuid branch. Unawaited: it is
      // paused holding the campaign row.
      const a = store.enqueueJob(campaignId);
      a.catch(() => undefined);
      await lockTaken;

      // B (the tombstone) on the pool's other connection. Its `update`'s ROW
      // EXCLUSIVE cannot be granted while A's `for share` is still open.
      const b = db.query(`update campaign set deleted_at = now() where id = $1`, [campaignId]);
      b.catch(() => undefined);
      const outcome = await Promise.race([
        b.then(() => "deleted"),
        sleep(300).then(() => "timeout"),
      ]);
      release();
      await Promise.all([a, b]);

      // ONLY AFTER both have settled: asserting before draining would wedge
      // `afterAll`'s `drop schema cascade` on an open transaction under the mutant.
      expect(outcome).toBe("timeout");
      const claimed = await a;
      expect(claimed).toEqual({ acquired: true, jobId: expect.any(String) });
      // The claim committed its job row — reachable by the campaign's uuid id,
      // which is what enqueueJob was called with.
      const { rows: found } = await db.query<{ id: string }>(
        `select id from job where org_id = $1 and campaign_id = $2`,
        ["local", campaignId],
      );
      expect(found[0]).toBeDefined();
      // B's tombstone committed after the claim: the row is now marked deleted.
      const { rows: deleted } = await db.query<{ deleted_at: Date | null }>(
        `select deleted_at from campaign where id = $1`,
        [campaignId],
      );
      expect(deleted[0]!.deleted_at).not.toBeNull();
      // D246 dual-key supplementary: a uuid-addressed run's job row is reachable
      // by either key once the claim is committed (not the lock proof, just the
      // cross-tenants shape a later tombstone read would lean on).
      const { rows: dual } = await db.query<{ found: number }>(
        `select 1 as found from job where org_id = $1 and campaign_id in ($2, $3) and status in ('queued', 'running')`,
        ["local", slug, campaignId],
      );
      expect(dual[0]!.found).toBe(1);
    });
  },
);
