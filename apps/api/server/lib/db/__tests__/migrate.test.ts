import { describe, test, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS_DIR, loadMigrations, migrate, type Migration } from "../migrate.js";
import type { SqlClient } from "../sql-client.js";
import { migratedDatabase, pgliteClient } from "./pglite-client.js";

const m = (id: string, sql: string): Migration => ({ id, sql });

describe("migrate (PT-3)", () => {
  let db: SqlClient | undefined;
  afterEach(async () => {
    await db?.end();
    db = undefined;
  });

  test("applies pending migrations in order, records them, and a second run applies nothing", async () => {
    db = pgliteClient();
    const all = [
      m("0001_a", "create table a (x int);"),
      m("0002_b", "create table b (y int); insert into b values (1);"),
    ];
    expect(await migrate(db, all)).toEqual(["0001_a", "0002_b"]);
    expect(await migrate(db, all)).toEqual([]);
    const { rows } = await db.query<{ id: string }>("select id from schema_migrations order by id");
    expect(rows.map((r) => r.id)).toEqual(["0001_a", "0002_b"]);
    expect((await db.query<{ n: number }>("select count(*)::int as n from b")).rows[0]!.n).toBe(1);
    expect(await migrate(db, [...all, m("0003_c", "create table c (z int);")])).toEqual(["0003_c"]);
  });

  test("a migration that fails applies nothing, not even the ones before it", async () => {
    db = pgliteClient();
    await expect(
      migrate(db, [m("0001_a", "create table a (x int);"), m("0002_bad", "create table nope (;")]),
    ).rejects.toThrow();
    const { rows } = await db.query<{ t: string | null }>("select to_regclass('a')::text as t");
    expect(rows[0]!.t).toBeNull();
  });

  test("a database ahead of this code, or missing an earlier migration, is refused", async () => {
    db = pgliteClient();
    await migrate(db, [m("0001_a", "select 1;"), m("0003_c", "select 1;")]);
    await expect(migrate(db, [m("0001_a", "select 1;")])).rejects.toThrow(
      "The database has applied migrations this code does not ship: 0003_c.",
    );
    await expect(
      migrate(db, [m("0001_a", "select 1;"), m("0002_b", "select 1;"), m("0003_c", "select 1;")]),
    ).rejects.toThrow("Migration 0002_b sorts before 0003_c, which is already applied.");
  });

  test("the shipped migrations create the org table with the local operator in it", async () => {
    db = await migratedDatabase();
    const { rows } = await db.query<{ id: string; name: string }>("select id, name from org");
    expect(rows).toEqual([{ id: "local", name: "Local operator" }]);
    await expect(
      db.query("insert into org (id, name) values ($1, $2)", ["../evil", "x"]),
    ).rejects.toThrow();
  });
});

describe("loadMigrations", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("reads NNNN_name.sql files in order and ignores other files", async () => {
    dir = mkdtempSync(join(tmpdir(), "cf-migrations-"));
    writeFileSync(join(dir, "0002_b.sql"), "select 2;");
    writeFileSync(join(dir, "0001_a.sql"), "select 1;");
    writeFileSync(join(dir, "README.md"), "notes");
    expect(await loadMigrations(dir)).toEqual([m("0001_a", "select 1;"), m("0002_b", "select 2;")]);
  });

  test("refuses a .sql file that is not named NNNN_name.sql", async () => {
    dir = mkdtempSync(join(tmpdir(), "cf-migrations-"));
    writeFileSync(join(dir, "add-users.sql"), "select 1;");
    await expect(loadMigrations(dir)).rejects.toThrow(
      "Migration add-users.sql is not named NNNN_name.sql.",
    );
  });

  test("defaults to the shipped migrations", async () => {
    dir = mkdtempSync(join(tmpdir(), "unused-"));
    expect((await loadMigrations()).map((x) => x.id)).toContain("0001_org");
    expect(MIGRATIONS_DIR).toMatch(/db[/\\]migrations$/);
  });
});
