import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { databaseConfig } from "../../db/database-config.js";
import { pgClient, poolOptions } from "../../db/pg-client.js";
import { loadMigrations, migrate } from "../../db/migrate.js";
import type { SqlClient } from "../../db/sql-client.js";
import { PgUsageStore } from "../pg-usage-store.js";

/**
 * PGlite (every other database test) is one connection: it can serialise a
 * sequential call, but it cannot make two calls arrive at Postgres at the same
 * instant, which is the race condition D175's advisory lock exists to close.
 * This file is the proof against a real server, over an actual two-connection
 * pool — skipped unless `TEST_DATABASE_URL` is set (CI's `postgres:17` service;
 * `.github/workflows/ci.yml`), never against the owner's Aiven service.
 *
 * It owns a schema it creates and drops, so it can run beside every other
 * test's own database (or its own re-run) without clashing on `usage`, `org` or
 * `schema_migrations`.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("PgUsageStore.reserve races two real connections (PT-7a2, D175)", () => {
  const schema = `pt7a2_test_${randomUUID().replaceAll("-", "_")}`;
  let db: SqlClient;

  beforeAll(async () => {
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
  });

  test("two concurrent reserve calls against quota - 1 admit exactly one", async () => {
    // Lowercase, digits and hyphens only: 0008 tightened `org_id_check` to that form.
    const orgId = `org-${randomUUID().slice(0, 18)}`;
    await db.query("insert into org (id, name, monthly_generation_quota) values ($1, $2, $3)", [
      orgId,
      "Racy Org",
      2,
    ]);

    const store = new PgUsageStore(db);
    // Pre-seed 1 recorded row so the org is at quota - 1 (1 out of 2)
    await store.record({
      orgId,
      provider: "imagen",
      model: "imagen-4.0",
      units: 1,
      keyOwner: "platform",
    });

    // Two concurrent reserve calls on separate pooled connections
    const [res1, res2] = await Promise.all([store.reserve(orgId), store.reserve(orgId)]);
    const admitted = [res1, res2].filter((id): id is string => typeof id === "string");
    const refused = [res1, res2].filter((id) => id === null);

    expect(admitted).toHaveLength(1);
    expect(refused).toHaveLength(1);

    // Verify exactly 2 rows exist (1 recorded, 1 reserved)
    const { rows } = await db.query<{ count: string }>(
      `select count(*)::text as count from usage where org_id = $1`,
      [orgId],
    );
    expect(Number(rows[0]!.count)).toBe(2);
  });
});
