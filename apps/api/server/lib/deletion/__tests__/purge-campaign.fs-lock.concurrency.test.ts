import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import pg from "pg";
import { databaseConfig } from "../../db/database-config.js";
import { pgClient, poolOptions } from "../../db/pg-client.js";
import { loadMigrations, migrate } from "../../db/migrate.js";
import type { SqlClient, SqlQuery } from "../../db/sql-client.js";
import { resetProjectRoot } from "@campaignfoundry/shared";
import { purgeCampaign, deleteCampaignRows } from "../purge-campaign.js";

const url = process.env.TEST_DATABASE_URL;
const ORG = "local";
const SLUG = "spring";

const sleep = (ms: number): Promise<"timeout"> =>
  new Promise((resolve) => {
    setTimeout(() => resolve("timeout"), ms);
  });

/*
 * Like deletion-store.concurrency.test.ts, this file is the proof over a real
 * Postgres of the row-lock that fs step 2 now takes. PGlite is one connection:
 * it can run the pausing client but cannot race two writers on the same row, so
 * this lane's manifest has no entry for it — see that file's header for why.
 */
describe.skipIf(!url)(
  "fs step 2 holds the campaign row so a concurrent row delete waits until the trees are freed (PT-9g4)",
  () => {
    const schema = `pt9g4_fs_${randomUUID().replaceAll("-", "_")}`;
    let db: SqlClient;
    let dir: string;
    const SAVED_OBJECT_STORE = process.env.OBJECT_STORE;

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), "cf-purge-fs-"));
      process.env.OUTPUT_DIR = dir;
      process.env.PROJECT_ROOT = dir;
      process.env.OBJECT_STORE = "fs";
      resetProjectRoot();

      const config = databaseConfig({ url, poolMax: "2" }, () => {
        throw new Error("a local TEST_DATABASE_URL needs no CA");
      });
      db = pgClient(
        config,
        (cfg) => new pg.Pool({ ...poolOptions(cfg), options: `-c search_path=${schema}` }),
      );
      await db.query(`create schema if not exists "${schema}"`);
      await migrate(db, await loadMigrations());
    });

    afterAll(async () => {
      await db.query(`drop schema if exists "${schema}" cascade`);
      await db.end();
      rmSync(dir, { recursive: true, force: true });
      if (SAVED_OBJECT_STORE === undefined) delete process.env.OBJECT_STORE;
      else process.env.OBJECT_STORE = SAVED_OBJECT_STORE;
      resetProjectRoot();
    });

    /**
     * Hold the first connection's transaction open AFTER its step-2 select has
     * taken the row `FOR SHARE`, but BEFORE the transaction commits — so a second
     * connection's `deleteCampaignRows` actually blocks on the row lock rather
     * than merely filtering the now-committed deletion row. A naive "start B,
     * then call A" test would NOT exercise this: B's step 2 runs in milliseconds
     * and commits before A reaches its `FOR UPDATE`, green on a `for share`
     * mutant. The pause is the witness.
     */
    function pausingClient(
      inner: SqlClient,
      pattern: RegExp,
      lockTaken: () => void,
      release: Promise<void>,
    ): SqlClient {
      return {
        ...inner,
        transaction: (work) =>
          inner.transaction(async (tx) => {
            const wrapped: SqlQuery = {
              query: async <R>(text: string, params?: readonly unknown[]) => {
                const result = await tx.query<R>(text, params);
                if (pattern.test(text)) {
                  lockTaken();
                  await release;
                }
                return result;
              },
              exec: (text: string) => tx.exec(text),
            };
            return work(wrapped);
          }),
      };
    }

    /** Plant a campaign row with a specific uuid, optionally tombstoned. */
    async function seedCampaign(
      db: SqlClient,
      orgId: string,
      slug: string,
      opts: { id?: string; tombstoned?: boolean } = {},
    ): Promise<string> {
      const { rows } = await db.query<{ id: string }>(
        `insert into campaign (id, org_id, slug, deleted_at)
           values (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4)
         returning id`,
        [opts.id ?? null, orgId, slug, opts.tombstoned ? new Date() : null],
      );
      return rows[0]!.id;
    }

    /** Plant a `deletion` row pointing at a campaign uuid. */
    async function seedDeletion(
      db: SqlClient,
      orgId: string,
      subject: string,
    ): Promise<{ id: string; subject: string }> {
      const { rows } = await db.query<{ id: string }>(
        `insert into deletion (org_id, kind, subject, requested_by, not_before)
           values ($1, 'campaign', $2, 'tester', now())
         returning id`,
        [orgId, subject],
      );
      return { id: rows[0]!.id, subject };
    }

    test("fs step 2 holds the campaign row so a concurrent row delete waits until the trees are freed", async () => {
      const xId = await seedCampaign(db, ORG, SLUG, { tombstoned: true });
      const deletionRow = await seedDeletion(db, ORG, xId);

      mkdirSync(join(dir, "assets", "inputs", SLUG), { recursive: true });
      writeFileSync(join(dir, "assets", "inputs", SLUG, "x.txt"), "data");
      mkdirSync(join(dir, SLUG), { recursive: true });
      writeFileSync(join(dir, SLUG, "x.txt"), "data");
      mkdirSync(join(dir, "packages", SLUG), { recursive: true });
      writeFileSync(join(dir, "packages", SLUG, "x.txt"), "data");

      let announce!: () => void;
      const announced = new Promise<void>((resolve) => {
        announce = resolve;
      });
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });

      // B: purgeCampaign on connection 2, paused right after the step-2
      // `select slug from campaign … for share` returns, holding that row lock.
      // The pattern is unique to step 2: step 3's select is
      // `select id, slug, deleted_at …`, which does not contain it.
      const dbB = pausingClient(db, /select slug from campaign/, announce, released);
      const b = purgeCampaign(dbB, ORG, deletionRow);
      b.catch(() => undefined);
      await announced;

      // A: deleteCampaignRows on connection 1 — blocks on B's `for share`.
      const a = deleteCampaignRows(db, ORG, xId);
      a.catch(() => undefined);

      // Mirror the deletion-store harness: race the NON-paused connection (A)
      // against sleep(300). With `for share` A blocks, so sleep wins; without it
      // A settles immediately and "settled" wins the race.
      const outcome = await Promise.race([
        a.then(() => "settled"),
        sleep(300).then(() => "timeout"),
      ]);

      // Release B and drain both connections FIRST, so a red run never wedges
      // afterAll's schema drop against an open transaction on the row.
      release();
      await a.catch(() => undefined);
      await b.catch(() => undefined);

      // The mutant-sensitive assertion, last: without `for share` A's `FOR UPDATE`
      // is not blocked, so it settles before sleep(300) and outcome is "settled".
      expect(outcome).toBe("timeout");

      // B's step 2 freed the trees before the lock was released; A then deleted
      // the campaign row, so B's step 3 returns "already-gone".
      expect(() => statSync(join(dir, "assets", "inputs", SLUG))).toThrow("ENOENT");
      expect(() => statSync(join(dir, SLUG))).toThrow("ENOENT");
      expect(() => statSync(join(dir, "packages", SLUG))).toThrow("ENOENT");

      const { rows: campaignCount } = await db.query<{ n: number }>(
        `select count(*)::int as n from campaign where id = $1::uuid`,
        [xId],
      );
      expect(campaignCount[0]!.n).toBe(0);
    });
  },
);
