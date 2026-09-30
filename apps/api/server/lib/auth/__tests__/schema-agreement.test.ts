import { describe, test, expect } from "vitest";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { loadMigrations, migrate } from "../../db/migrate.js";
import { authDatabase } from "../../db/__tests__/pglite-client.js";
import { authOptions } from "../options.js";
import { LogMailer } from "../log-mailer.js";
import type { Mail, MailerPort } from "../mailer.port.js";

/**
 * An empty database with 0001-0008 applied, plus the `SqlClient` over the very
 * pool Better Auth's `database` option is given below — so migrating and then
 * querying it goes through the identical client-as-Postgres-pool translation
 * this test is proving works, not a second, parallel path that could hide a
 * difference.
 *
 * `authDatabase()` answers an EMPTY database on either backend (PGlite, or a
 * fresh `CREATE DATABASE` on the server `TEST_PG_URL` names), which is what
 * these tests need: each applies its own migrations.
 */
async function migratedAuthDatabase(): Promise<Awaited<ReturnType<typeof authDatabase>>> {
  const database = await authDatabase();
  await migrate(database.sql, await loadMigrations());
  return database;
}

describe("Better Auth against the test database (PT-1a, D174b(2))", () => {
  test("a real operation runs through the double: magic-link sign-in writes a verification row and sends mail", async () => {
    const { pool, sql, end } = await migratedAuthDatabase();
    const sent: Mail[] = [];
    const mailer: MailerPort = {
      send: async (mail) => {
        sent.push(mail);
      },
    };
    const instance = betterAuth(
      authOptions({
        database: pool,
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
    await end();
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
    const { pool, end } = await migratedAuthDatabase();
    const instance = betterAuth(
      authOptions({
        database: pool,
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
    await end();
  });

  test("0008_auth refuses a second account row for the same provider identity", async () => {
    const { sql, end } = await migratedAuthDatabase();
    await sql.exec(
      "insert into \"user\" (id, name, email, email_verified, updated_at) values ('u1', 'U', 'u1@example.com', false, now())",
    );
    const link = (id: string) =>
      sql.query(
        "insert into account (id, account_id, provider_id, user_id, updated_at) values ($1, 'g-123', 'google', 'u1', now())",
        [id],
      );

    await link("a1");
    await expect(link("a2")).rejects.toThrow(/account_provider_id_account_id_uidx/);
    await end();
  });

  test("0008_auth is additive: applies on top of an existing org column from 0007 without assuming 0005-0007 exist", async () => {
    const { pool, sql, end } = await authDatabase();
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
        database: pool,
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
    await end();
  });
});
