import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import pg from "pg";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { databaseConfig } from "../../db/database-config.js";
import { pgClient, poolOptions } from "../../db/pg-client.js";
import { loadMigrations, migrate } from "../../db/migrate.js";
import type { SqlClient } from "../../db/sql-client.js";
import { inputPrefix } from "../../object-store/object-keys.js";
import { ObjectAssetStore } from "../object-asset-store.js";

/**
 * The unique index as the exclusive create, against TWO REAL CONNECTIONS
 * (PT-4b).
 *
 * PGlite is one connection: it can serialise a second `writeAsset` after the
 * first, and that is exactly what every other test in this lane does. What it
 * cannot do is have both statements reach Postgres at the same instant, which
 * is the one thing `unique (campaign_id, kind, name)` exists to survive — the
 * two uploads both mint different asset ids, so both `put`s succeed and only
 * the index can refuse the second insert. Skipped unless `TEST_DATABASE_URL` is
 * set (CI's `postgres:17` service), never against the owner's service.
 *
 * It owns a schema it creates and drops, so it can run beside every other
 * test's own database without clashing on `asset`, `org` or `schema_migrations`.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("ObjectAssetStore.writeAsset races two real connections (PT-4b)", () => {
  const schema = `pt4b_test_${randomUUID().replaceAll("-", "_")}`;
  let db: SqlClient;

  beforeAll(async () => {
    const config = databaseConfig({ url, poolMax: "2" }, () => {
      throw new Error("a local TEST_DATABASE_URL needs no CA");
    });
    // Every connection in the pool starts in this schema (a libpq startup
    // option, applied per connection — `search_path` cannot be set once for a
    // pool the way a single session could). `CREATE SCHEMA` itself names the
    // schema explicitly, so this is safe to run before the schema exists.
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

  test("two concurrent uploads of one name: one row, one object, the other EEXIST", async () => {
    // Both stores are the SAME org and campaign, as two requests in one process
    // would be; the object store is the in-memory fake, so what races here is
    // the database and nothing else. Separate stores, because each
    // `writeAsset` mints its own asset id and a shared instance would hide
    // nothing here but would read as if the adapter cached something.
    const slug = `race-${randomUUID().slice(0, 8)}`;
    const { rows } = await db.query<{ id: string }>(
      `insert into campaign (org_id, slug) values ('local', $1) returning id`,
      [slug],
    );
    const campaignId = rows[0]!.id;
    const store = new InMemoryObjectStore();
    const outcomes = await Promise.allSettled([
      new ObjectAssetStore(db, store, "local").writeAsset(slug, "logo.png", Buffer.from([1, 2, 3])),
      new ObjectAssetStore(db, store, "local").writeAsset(slug, "logo.png", Buffer.from([4, 5, 6])),
    ]);

    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const refused = outcomes.find((o) => o.status === "rejected");
    expect((refused as PromiseRejectedResult).reason).toMatchObject({ code: "EEXIST" });

    // And the invariant the refusal exists for: the loser's object did not stay.
    const { rows: assets } = await db.query<{ n: number }>(
      `select count(*)::int as n from asset where org_id = 'local' and campaign_id = $1`,
      [campaignId],
    );
    expect(assets[0]!.n).toBe(1);
    expect(await store.list(inputPrefix("local", campaignId))).toHaveLength(1);
  });
});
