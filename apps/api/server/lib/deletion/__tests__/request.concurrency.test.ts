import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import pg from "pg";
import { databaseConfig } from "../../db/database-config.js";
import { pgClient, poolOptions } from "../../db/pg-client.js";
import { loadMigrations, migrate } from "../../db/migrate.js";
import type { SqlClient, SqlQuery } from "../../db/sql-client.js";
import { CampaignGoneError } from "../../ports/job-store.port.js";
import { PgJobStore } from "../../ports/pg-job-store.js";
import { requestCampaignDeletion } from "../request.js";

/**
 * D235's mutual exclusion: a DELETE ∥ generate over the SAME campaign row gives
 * exactly one winner, the other refusing. PGlite is one connection: it can prove
 * each transaction's logic, but it cannot prove a `for update` actually BLOCKS a
 * concurrent `for share`. This file is the proof over a real server, over an
 * actual two-connection pool — skipped unless `TEST_DATABASE_URL` is set (CI's
 * `postgres:17` service; never against the owner's Aiven service).
 *
 * It owns a schema it creates and drops, so it runs beside every other test's
 * own database without clashing on `campaign`, `job`, `deletion` or
 * `schema_migrations`.
 *
 * `TEST_DATABASE_URL` — not `TEST_PG_URL` — is why this file is NOT in the
 * lane's manifest: CI's manifest-replay runs before the `Test` step that exports
 * `TEST_DATABASE_URL`, so a manifest entry witnessed only here would replay with
 * no real server and turn CI red on a claim the gate cannot check.
 */
const url = process.env.TEST_DATABASE_URL;

const sleep = (ms: number): Promise<"timeout"> =>
  new Promise((resolve) => {
    setTimeout(() => resolve("timeout"), ms);
  });

describe.skipIf(!url)(
  "requestCampaignDeletion ∥ generate mutual exclusion (D235): one winner, the other refuses",
  () => {
    const schema = `pt9f_test_${randomUUID().replaceAll("-", "_")}`;
    let db: SqlClient;

    beforeAll(async () => {
      const config = databaseConfig({ url, poolMax: "2" }, () => {
        throw new Error("a local TEST_DATABASE_URL needs no CA");
      });
      // `poolMax: "2"` is the binding constraint: one connection is held by the
      // claim (or tombstone) transaction for the whole of the interleaving, so the
      // other is the only other actor that can exist.
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

    test("a claim committed first makes the delete wait, then refuse: the active job is visible once the campaign row is granted", async () => {
      const slug = `pt9f-a-${randomUUID().slice(0, 8)}`;
      const { rows: campaigns } = await db.query<{ id: string }>(
        `insert into campaign (org_id, slug) values ('local', $1) returning id`,
        [slug],
      );
      const campaignId = campaigns[0]!.id;

      // Pause wrapper: the first `insert into job` announces and awaits `released`.
      // By the time the claim reaches the insert, `campaignClaimable` has already
      // taken the campaign row `for share` — so A holds the lock during the pause.
      let announceLock!: () => void;
      const lockTaken = new Promise<void>((resolve) => {
        announceLock = resolve;
      });
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const wrapped: SqlClient = {
        ...db,
        transaction: (work) =>
          db.transaction((tx) => {
            const intercept: SqlQuery = {
              ...tx,
              query: async <R>(text: string, params?: readonly unknown[]) => {
                if (text.includes("insert into job")) {
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

      // A (the claim) launches first, unawaited: it pauses holding the campaign
      // row `for share`.
      const a = store.enqueueJob(slug);
      a.catch(() => undefined);
      await lockTaken;

      // B (the tombstone) launches after A holds the row: its `for update` blocks
      // on A's `for share`.
      const b = requestCampaignDeletion(db, {
        orgId: "local",
        campaignId,
        requestedBy: "u1",
        mayDelete: () => true,
        graceHours: 0,
      });
      const outcome = await Promise.race([
        b.then(
          () => "settled",
          () => "settled",
        ),
        sleep(300),
      ]);

      // Release A and drain B FIRST, so a red run never wedges `afterAll`'s schema
      // drop against an open transaction on the row.
      release();
      await Promise.allSettled([a, b]);

      // A committed first, so B's `for update` was granted, B read the job row,
      // and B refused with a 409-style outcome naming A's job id.
      expect(outcome).toBe("timeout");
      const claimed = await a;
      expect(claimed).toEqual({ acquired: true, jobId: expect.any(String) });
      if (claimed.acquired !== true) throw new Error("expected claim to succeed");
      const refused = await b;
      expect(refused).toEqual({ outcome: "active-job", jobId: claimed.jobId });

      // The tombstone committed nothing.
      const { rows: campaign } = await db.query<{ deleted_at: Date | null }>(
        `select deleted_at from campaign where id = $1`,
        [campaignId],
      );
      expect(campaign[0]!.deleted_at).toBeNull();
      const { rows: count } = await db.query<{ n: number }>(
        `select count(*)::int as n from deletion`,
      );
      expect(count[0]!.n).toBe(0);
    });

    test("a delete committed first makes the claim refuse: the claim waits on the open tombstone", async () => {
      const slug = `pt9f-b-${randomUUID().slice(0, 8)}`;
      const { rows: campaigns } = await db.query<{ id: string }>(
        `insert into campaign (org_id, slug) values ('local', $1) returning id`,
        [slug],
      );
      const campaignId = campaigns[0]!.id;

      // Pause wrapper: the first `insert into deletion` announces and awaits
      // `released`. By the time the tombstone reaches the insert, its `for update`
      // select has already locked the campaign row AND its `update campaign set
      // deleted_at = now()` has already run — so B holds the lock with the tombstone
      // in place during the pause.
      let announce!: () => void;
      const announced = new Promise<void>((resolve) => {
        announce = resolve;
      });
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const wrapped: SqlClient = {
        ...db,
        transaction: (work) =>
          db.transaction((tx) => {
            const intercept: SqlQuery = {
              ...tx,
              query: async <R>(text: string, params?: readonly unknown[]) => {
                if (text.includes("insert into deletion")) {
                  announce();
                  await released;
                }
                return tx.query<R>(text, params);
              },
            };
            return work(intercept);
          }),
      };

      // B (the tombstone) launches first, unawaited: it pauses holding the campaign
      // row `for update` with `deleted_at` already set.
      const b = requestCampaignDeletion(wrapped, {
        orgId: "local",
        campaignId,
        requestedBy: "u1",
        mayDelete: () => true,
        graceHours: 0,
      });
      b.catch(() => undefined);
      await announced;

      // A (the claim) launches after B holds the row: its `for share` blocks on
      // B's `for update`.
      const store = new PgJobStore(db, "local");
      const a = store.enqueueJob(slug);
      a.catch(() => undefined);
      const outcome = await Promise.race([
        a.then(
          () => "settled",
          () => "settled",
        ),
        sleep(300),
      ]);

      // Release B and drain A FIRST.
      release();
      await Promise.allSettled([a, b]);

      // B committed first, so A's `for share` was granted, A read the tombstoned
      // row, and A refused with CampaignGoneError — it inserted no job.
      expect(outcome).toBe("timeout");
      await expect(a).rejects.toBeInstanceOf(CampaignGoneError);
      const settled = await b;
      expect(settled).toEqual({ outcome: "requested", deletionId: expect.any(String) });

      // No job row survives: the claim refused before inserting one.
      const { rows: count } = await db.query<{ n: number }>(
        `select count(*)::int as n from job where org_id = $1 and campaign_id in ($2, $3)`,
        ["local", slug, campaignId],
      );
      expect(count[0]!.n).toBe(0);

      // The tombstone is committed.
      const { rows: campaign } = await db.query<{ deleted_at: Date | null }>(
        `select deleted_at from campaign where id = $1`,
        [campaignId],
      );
      expect(campaign[0]!.deleted_at).not.toBeNull();
      const { rows: deletionCount } = await db.query<{ n: number }>(
        `select count(*)::int as n from deletion`,
      );
      expect(deletionCount[0]!.n).toBe(1);
    });
  },
);
