import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import pg from "pg";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
  type CampaignBrief,
} from "@campaignfoundry/CampaignOrchestration";
import { testServerConfig } from "../../db/__tests__/test-server-config.js";
import { pgClient, poolOptions } from "../../db/pg-client.js";
import { loadMigrations, migrate } from "../../db/migrate.js";
import type { SqlClient, SqlQuery } from "../../db/sql-client.js";
import { PgBriefStore } from "../pg-brief-store.js";

/**
 * D236's `for share`, against TWO REAL CONNECTIONS (PT-9d).
 *
 * The check and the version insert share one transaction, and what has to be
 * proven is that the `for share` really holds the asset row across the write
 * that follows it. One PGlite/one-pool client cannot show that at all: both
 * statements are serialised by the connection itself, so the "concurrent"
 * deleter is not concurrent with anything. Skipped unless `TEST_DATABASE_URL` is
 * set (CI's `postgres:17` service), never against the owner's service — this is
 * a different variable from `TEST_PG_URL`, which selects the per-test clone
 * harness (`db/__tests__/test-database.ts`'s own docstring says so).
 *
 * **`TEST_DATABASE_URL` and not `TEST_PG_URL` is also why this mutation is NOT
 * in the lane's manifest.** CI's manifest-replay step runs before the `Test`
 * step that exports `TEST_DATABASE_URL`, so a manifest entry witnessed only here
 * would be replayed with no real server reachable and turn CI red on a claim the
 * gate structurally cannot check. This file is the witness instead.
 *
 * It owns a schema it creates and drops, so it can run beside every other test's
 * own database without clashing on `asset`, `org` or `schema_migrations`.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("PgBriefStore's ref check blocks a concurrent delete (PT-9d, D236)", () => {
  const schema = `pt9d_test_${randomUUID().replaceAll("-", "_")}`;
  let db: SqlClient;

  beforeAll(async () => {
    const config = testServerConfig({ url, poolMax: "2" }, "TEST_DATABASE_URL");
    // Every connection in the pool starts in this schema (a libpq startup
    // option, applied per connection — `search_path` cannot be set once for a
    // pool the way a single session could). `CREATE SCHEMA` itself names the
    // schema explicitly, so this is safe to run before the schema exists.
    // `poolMax: "2"` is the binding constraint, not a tuning choice: one
    // connection is held by the store's open transaction for the whole of the
    // interleaving, so the second connection's delete is the only other actor
    // that can exist.
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

  const briefWithRef = (id: string, ref: string): CampaignBrief => ({
    schemaVersion: BRIEF_SCHEMA_VERSION,
    template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
    id,
    targetRegion: "US",
    targetAudience: "developers",
    campaignMessage: "Build great things",
    products: [
      { id: "prod-1", name: "Product 1", primaryColor: "#1473E6", logoPath: ref, inputAsset: ref },
    ],
  });

  const sleep = (ms: number): Promise<"timeout"> =>
    new Promise((resolve) => {
      setTimeout(() => resolve("timeout"), ms);
    });

  test("a raw delete of a named asset on a second connection blocks until the version commits", async () => {
    const slug = `pt9d-${randomUUID().slice(0, 8)}`;
    const { rows: campaigns } = await db.query<{ id: string }>(
      `insert into campaign (org_id, slug) values ('local', $1) returning id`,
      [slug],
    );
    const campaignId = campaigns[0]!.id;
    await db.query(
      `insert into brief_version (campaign_id, version, body, revision, actor)
       values ($1, 1, $2, $3, 'local')`,
      [campaignId, JSON.stringify(briefWithRef(slug, "assets/inputs/logo.png")), "seed"],
    );
    const { rows: assets } = await db.query<{ id: string }>(
      `insert into asset (org_id, campaign_id, kind, name, size, sha256, content_type)
       values ('local', $1, 'input', 'logo.png', 3, $2, 'image/png') returning id`,
      [campaignId, "0".repeat(64)],
    );
    const assetId = assets[0]!.id;

    // The lock is taken by the STORE'S OWN `for share` select, driven through
    // `rewriteBrief` — never by a lock statement this test issues itself, which
    // would prove nothing about the store's SQL (dropping `for share` would
    // leave such a test green, which is the mutation-test-the-test failure).
    // So the transaction is paused on the FIRST statement that comes AFTER the
    // select has already run and returned: by then the asset row is genuinely
    // locked by this transaction, and the only thing held back is the write.
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
              if (!paused && text.includes("insert into brief_version")) {
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
    const store = new PgBriefStore(wrapped, "local", "local", [], [], true);

    // 1. The store's transaction starts, checks the refs, and pauses holding the
    //    asset row. Unawaited: it cannot finish until this test lets it.
    const a = store.rewriteBrief(briefWithRef(slug, assetId));
    a.catch(() => undefined); // the assertion below may never reach `a`; this is not a swallow
    // 2. The select has run and returned; the row is locked.
    await lockTaken;
    // 3. A RAW delete on the pool's other connection, unawaited. Never
    //    `deleteAssets` (it takes no campaign-row lock either, so it would not
    //    serialise and the point would be moot) and never
    //    `freeUnreferencedAssets` (unmerged, PT-9e; it takes that lock, which
    //    would serialise this test on something else and make the mutant vacuous).
    const b = db.query(`delete from asset where id = $1`, [assetId]);
    b.catch(() => undefined);
    // 4. Did it block? A 300 ms window against a lock the store is holding open.
    const outcome = await Promise.race([b.then(() => "deleted"), sleep(300).then(() => "timeout")]);
    // 5. Drain BOTH before asserting anything. The mutant's own failure is an
    //    `expect` below, and an `expect` thrown while A's transaction is still
    //    waiting on `released` would wedge `afterAll`'s `drop schema cascade` on
    //    an open connection — the assertion has to be the LAST thing done, not
    //    merely the last thing said.
    release();
    await Promise.all([a, b]);
    expect(outcome).toBe("timeout");
    // And the two facts that make the timeout mean something: A committed its
    // version, and B's delete ran AFTER that commit rather than instead of it.
    const { rows: versions } = await db.query<{ n: number }>(
      `select count(*)::int as n from brief_version where campaign_id = $1`,
      [campaignId],
    );
    expect(versions[0]!.n).toBe(2);
    const { rows: gone } = await db.query<{ n: number }>(
      `select count(*)::int as n from asset where id = $1`,
      [assetId],
    );
    expect(gone[0]!.n).toBe(0);
  });
});
