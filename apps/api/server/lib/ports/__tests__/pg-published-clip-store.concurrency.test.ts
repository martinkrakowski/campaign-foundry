import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { testServerConfig } from "../../db/__tests__/test-server-config.js";
import { pgClient, poolOptions } from "../../db/pg-client.js";
import { loadMigrations, migrate } from "../../db/migrate.js";
import type { SqlClient } from "../../db/sql-client.js";
import {
  PgPublishedClipStore,
  PublishedClipRecordRefusedError,
} from "../pg-published-clip-store.js";

/**
 * PGlite (every other database test) is one connection: it can prove a
 * record's sequential outcomes, but it cannot make a `record()` arrive at
 * Postgres while a tombstone transaction holds the campaign row, which is
 * the one thing CFAR6-record's `for share` exists to survive. This file is
 * the proof against a real server, over an actual two-connection pool —
 * skipped unless `TEST_DATABASE_URL` is set (CI's `postgres:17` service),
 * never against a real database.
 *
 * It owns a schema it creates and drops, so it can run beside every other
 * test's own database (or its own re-run) without clashing on `campaign`,
 * `published_clip`, `org` or `schema_migrations`.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("PgPublishedClipStore.record races a real tombstone (CFAR6-record)", () => {
  const schema = `cfar6j_test_${randomUUID().replaceAll("-", "_")}`;
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
    await migrate(db, await loadMigrations());
  });

  afterAll(async () => {
    await db.query(`drop schema if exists "${schema}" cascade`);
    await db.end();
  });

  test("record blocks on a concurrent for-update tombstone transaction and refuses once deleted_at commits", async () => {
    const orgId = `cfar6j-${randomUUID().slice(0, 18)}`;
    await db.query("insert into org (id, name) values ($1, $2)", [orgId, "Cfar six j"]);
    const campaignId = randomUUID();
    await db.query(`insert into campaign (id, org_id, slug) values ($1::uuid, $2, 'cfar6j-one')`, [
      campaignId,
      orgId,
    ]);

    // Connection 1: take the `for update` lock the tombstone transaction
    // takes, signal that it is held, linger so connection 2 must reach
    // Postgres and wait on the row lock, then tombstone and commit.
    let releaseLockHeld: () => void = () => {};
    const lockHeld = new Promise<void>((resolve) => {
      releaseLockHeld = resolve;
    });
    const tombstone = db.transaction(async (tx) => {
      await tx.query(`select id from campaign where org_id = $1 and id = $2::uuid for update`, [
        orgId,
        campaignId,
      ]);
      releaseLockHeld();
      // Give connection 2 time to arrive and block on the row lock: without
      // the `for share` in record()'s CTE it would sail past, insert the row
      // against the pre-tombstone snapshot, and answer "recorded".
      await new Promise((resolve) => setTimeout(resolve, 200));
      await tx.query(`update campaign set deleted_at = now() where org_id = $1 and id = $2::uuid`, [
        orgId,
        campaignId,
      ]);
    });

    // Connection 2: the export's record, for the same org and campaign,
    // while the tombstone transaction is still uncommitted.
    const record = lockHeld.then(() =>
      new PgPublishedClipStore(db).record(
        orgId,
        campaignId,
        `${orgId}/aaa/0123.mp4`,
        "https://pub/aaa.mp4",
        "0123",
      ),
    );

    await expect(record).rejects.toBeInstanceOf(PublishedClipRecordRefusedError);
    await tombstone;

    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from published_clip where org_id = $1`,
      [orgId],
    );
    expect(rows[0]!.n).toBe(0);
  });
});
