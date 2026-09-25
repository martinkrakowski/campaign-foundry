import { describe, test, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { loadMigrations, migrate } from "../../db/migrate.js";
import { pgClient } from "../../db/pg-client.js";
import type { DatabaseConfig } from "../../db/database-config.js";
import type { SqlClient } from "../../db/sql-client.js";
import { pglitePgPool } from "../../db/__tests__/pglite-pg-pool.js";
import { authOptions } from "../options.js";
import { LogMailer } from "../log-mailer.js";
import type { Mail, MailerPort } from "../mailer.port.js";

// Never used to connect: `pgClient`'s `makePool` override replaces the real
// `pg.Pool` this would otherwise build with the PGlite double, but `pgClient`
// still destructures the config's shape.
const DUMMY_CONFIG: DatabaseConfig = {
  host: "localhost",
  port: 5432,
  user: "test",
  password: "test",
  database: "test",
  ssl: false,
  max: 1,
};

/**
 * A fresh PGlite database with 0001-0008 applied, plus a `SqlClient` over it
 * built through the exact same `pgClient()`/`pglitePgPool()` pair Better Auth's
 * `database` option uses below — so migrating and querying it afterwards go
 * through the identical PGlite-as-Postgres-pool translation this test is
 * proving works, not a second, parallel path (`pglite-client.ts`'s own
 * `pgliteClient()`) that could hide a difference.
 */
async function migratedPglite(): Promise<{ raw: PGlite; sql: SqlClient }> {
  const raw = new PGlite();
  const sql = pgClient(DUMMY_CONFIG, () => pglitePgPool(raw));
  await migrate(sql, await loadMigrations());
  return { raw, sql };
}

describe("Better Auth against PGlite (PT-1a, D174b(2))", () => {
  test("a real operation runs through the double: magic-link sign-in writes a verification row and sends mail", async () => {
    const { raw, sql } = await migratedPglite();
    const sent: Mail[] = [];
    const mailer: MailerPort = {
      send: async (mail) => {
        sent.push(mail);
      },
    };
    const instance = betterAuth(
      authOptions({
        database: pglitePgPool(raw),
        secret: "a".repeat(32),
        baseURL: "http://127.0.0.1:3001",
        mailer,
      }),
    );

    const result = await instance.api.signInMagicLink({
      body: { email: "person@example.com" },
      headers: new Headers(),
    });

    expect(result.status).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("person@example.com");
    // `identifier` is the opaque magic-link token (the lookup key), not the
    // email; a written row at all is the proof this test needs — the token's
    // shape is Better Auth's concern, not ours.
    const rows = await sql.query<{ identifier: string; value: string }>(
      "select identifier, value from verification",
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.identifier).toEqual(expect.any(String));
    await sql.end();
  });

  /**
   * The falsifiable claim D174b(2) makes: 0008_auth's hand-written SQL is
   * exactly the schema `betterAuth()`'s own migration inspection (Kysely's
   * introspection, diffed against `authOptions()`'s field mapping) would have
   * generated. If a table, a column or an index in `options.ts` drifts from
   * 0008's SQL, this is the test that turns red — not a runtime surprise the
   * first time a route touches the missing piece.
   */
  test("0008_auth leaves nothing for Better Auth's own migration inspection to create", async () => {
    const { raw, sql } = await migratedPglite();
    const instance = betterAuth(
      authOptions({
        database: pglitePgPool(raw),
        secret: "a".repeat(32),
        baseURL: "http://127.0.0.1:3001",
        mailer: new LogMailer(),
      }),
    );

    const plan = await getMigrations(instance.options, { throwOnUnsafe: false });

    expect(plan.toBeCreated).toEqual([]);
    expect(plan.toBeAdded).toEqual([]);
    expect(plan.toBeAddedIndexes).toEqual([]);
    expect(plan.unsafeChanges).toEqual([]);
    await sql.end();
  });

  test("0008_auth is additive: applies on top of an existing org column from 0007 without assuming 0005-0007 exist", async () => {
    const raw = new PGlite();
    const sql = pgClient(DUMMY_CONFIG, () => pglitePgPool(raw));
    const all = await loadMigrations();
    const prior = all.filter((m) => m.id < "0008_auth");
    await migrate(sql, prior);

    // Simulate 0007 having added an org column prior to 0008
    await sql.exec("alter table org add column quota integer;");

    await migrate(sql, all);

    const columns = await sql.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name = 'org'",
    );
    const names = new Set(columns.rows.map((r) => r.column_name));
    expect(names.has("quota")).toBe(true);
    expect(names.has("slug")).toBe(true);
    expect(names.has("logo")).toBe(true);
    expect(names.has("metadata")).toBe(true);

    const instance = betterAuth(
      authOptions({
        database: pglitePgPool(raw),
        secret: "a".repeat(32),
        baseURL: "http://127.0.0.1:3001",
        mailer: new LogMailer(),
      }),
    );
    const plan = await getMigrations(instance.options, { throwOnUnsafe: false });
    expect(plan.toBeCreated).toEqual([]);
    expect(plan.toBeAdded).toEqual([]);
    expect(plan.toBeAddedIndexes).toEqual([]);
    expect(plan.unsafeChanges).toEqual([]);
    await sql.end();
  });
});
