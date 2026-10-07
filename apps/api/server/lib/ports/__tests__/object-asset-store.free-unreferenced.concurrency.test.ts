import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import pg from "pg";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
  type CampaignBrief,
} from "@campaignfoundry/CampaignOrchestration";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { testServerConfig } from "../../db/__tests__/test-server-config.js";
import { pgClient, poolOptions } from "../../db/pg-client.js";
import { loadMigrations, migrate } from "../../db/migrate.js";
import type { SqlClient, SqlQuery } from "../../db/sql-client.js";
import { inputPrefix } from "../../object-store/object-keys.js";
import { BriefRefNotFoundError } from "../../brief-asset-refs.js";
import { ObjectAssetStore } from "../object-asset-store.js";
import { PgBriefStore } from "../pg-brief-store.js";

/**
 * D237's real-PG interleaving: a free in flight holds the campaign row until its
 * delete decides, so a concurrent createBrief naming the same id must wait.
 *
 * PGlite is one connection: it cannot show two writers racing on the same row
 * — the second `select ... for update` simply waits its turn behind the first
 * on the same connection. What it cannot prove is that the lock is HELD across
 * the gap between the select and the delete: under the `for update` mutant the
 * select takes no lock, the second writer never blocks, and its version commits
 * before the delete runs — the `not exists` guard then sees that version and
 * frees nothing. This file runs against a real Postgres (`TEST_DATABASE_URL`)
 * with exactly two pooled connections.
 *
 * Header, pause/race machinery, and seed shape are borrowed from
 * `object-asset-store.concurrency.test.ts` and `pg-brief-store.concurrency.test.ts`
 * verbatim; the match string is `"delete from asset"`, because it is A's own
 * transaction (not B's) that must pause, AFTER its `for update` select has
 * already run and returned.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)(
  "ObjectAssetStore.freeUnreferencedAssets blocks a concurrent createBrief (PT-9e2, D237)",
  () => {
    const schema = `pt9e_test_${randomUUID().replaceAll("-", "_")}`;
    let db: SqlClient;

    beforeAll(async () => {
      const config = testServerConfig({ url, poolMax: "2" }, "TEST_DATABASE_URL");
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
    });

    const briefWithRef = (id: string, ref: string): CampaignBrief => ({
      schemaVersion: BRIEF_SCHEMA_VERSION,
      template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
      id,
      targetRegion: "US",
      targetAudience: "developers",
      campaignMessage: "Build great things",
      products: [
        {
          id: "prod-1",
          name: "Product 1",
          primaryColor: "#1473E6",
          logoPath: ref,
          inputAsset: ref,
        },
      ],
    });

    const sleep = (ms: number): Promise<"timeout"> =>
      new Promise((resolve) => {
        setTimeout(() => resolve("timeout"), ms);
      });

    const PNG = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );

    test("a free in flight makes a same-asset write wait: the campaign row stays locked until the delete decides", async () => {
      const slug = `pt9e-${randomUUID().slice(0, 8)}`;
      const { rows: campaigns } = await db.query<{ id: string }>(
        `insert into campaign (org_id, slug) values ('local', $1) returning id`,
        [slug],
      );
      const campaignId = campaigns[0]!.id;

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
                if (!paused && text.includes("delete from asset")) {
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
      const dbA: SqlClient = wrapped;
      const dbB = db;
      const objectStore = new InMemoryObjectStore();
      const store = new ObjectAssetStore(dbA, objectStore, "local");
      const briefs = new PgBriefStore(dbB, "local", "local", [], [], true);

      // Seed the asset through the SAME store that will free it — writeAsset
      // uses dbA.query (the raw, un-intercepted query), not dbA.transaction,
      // so the pause is not triggered here.
      const written = await store.writeAsset(slug, "logo.png", PNG);
      const assetId = written.id!;

      // 1. The store's transaction starts, takes the campaign row `for update`,
      //    and pauses on its own `delete from asset` — by then the lock is held.
      const a = store.freeUnreferencedAssets(slug, [assetId]);
      a.catch(() => undefined);
      // 2. The for-update select has run and returned; the row is locked.
      await lockTaken;
      // 3. A concurrent createBrief on the pool's other connection: its
      //    transaction opens with the SAME campaign row `for update`, so it
      //    blocks on A's open lock.
      const b = briefs.createBrief(briefWithRef(slug, assetId));
      b.catch(() => undefined);
      // 4. Did it block? A 300 ms window against a lock the store is holding.
      const outcome = await Promise.race([
        b.then(
          () => "settled",
          () => "settled",
        ),
        sleep(300).then(() => "timeout"),
      ]);
      // 5. Drain BOTH before asserting: release the pause, let A's delete run
      //    and commit (freeing the asset), let B then acquire the row and find
      //    the asset gone — assertRefsExist throws BriefRefNotFoundError, so
      //    createBrief REJECTS and no version is written.
      release();
      await Promise.allSettled([a, b]);
      // 6. The mutant-sensitive line: without `for update`, B is never blocked,
      //    wins the race, writes its version FIRST — outcome reads "settled".
      expect(outcome).toBe("timeout");
      // 7. End-state: A's free completed (asset row deleted, object discarded),
      //    B's createBrief was refused (no version written).
      await expect(a).resolves.toBeUndefined();
      await expect(b).rejects.toBeInstanceOf(BriefRefNotFoundError);
      const { rows: assetCount } = await db.query<{ n: number }>(
        `select count(*)::int as n from asset where id = $1`,
        [assetId],
      );
      expect(assetCount[0]!.n).toBe(0);
      const { rows: versionCount } = await db.query<{ n: number }>(
        `select count(*)::int as n from brief_version where campaign_id = $1`,
        [campaignId],
      );
      expect(versionCount[0]!.n).toBe(0);
      // The object was discarded by A after its transaction committed.
      expect(await objectStore.list(inputPrefix("local", campaignId))).toHaveLength(0);
    });
  },
);
