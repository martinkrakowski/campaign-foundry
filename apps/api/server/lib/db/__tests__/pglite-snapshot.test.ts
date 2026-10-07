import { describe, test, expect, it, inject, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { checksum, loadMigrations, migrate, type Migration } from "../migrate.js";
import { snapshotKey, buildSnapshots } from "./pglite-snapshot.js";
import { emptyDatabase, migratedDatabase } from "./pglite-client.js";

const m = (id: string, sql: string): Migration => ({ id, sql });

describe("pglite snapshot harness", () => {
  test("two databases from one snapshot are independent", async () => {
    const db1 = await migratedDatabase();
    const db2 = await migratedDatabase();
    await db1.query("insert into org (id, name) values ($1, $2)", ["test-snap", "Snapshot test"]);
    const { rows } = await db2.query<{ n: number }>(
      "select count(*)::int as n from org where id = 'test-snap'",
    );
    expect(rows[0]!.n).toBe(0);
    await db1.end();
    await db2.end();
  });

  test("migratedDatabase has every shipped migration recorded", async () => {
    const db = await migratedDatabase();
    const { rows } = await db.query<{ id: string; checksum: string }>(
      "select id, checksum from schema_migrations order by id",
    );
    expect(rows).toEqual(
      (await loadMigrations()).map((m) => ({ id: m.id, checksum: checksum(m.sql) })),
    );
    const org = await db.query<{ id: string }>("select id from org order by id");
    expect(org.rows).toEqual([{ id: "local" }]);
    await db.end();
  });

  test("migrate on a snapshot-loaded database applies nothing", async () => {
    const db = await migratedDatabase();
    expect(await migrate(db, await loadMigrations())).toEqual([]);
    await db.end();
  });

  test("emptyDatabase has no migration applied", async () => {
    const db = await emptyDatabase();
    const { rows } = await db.query<{ n: number }>(
      "select count(*)::int as n from information_schema.tables where table_name = 'schema_migrations'",
    );
    expect(rows[0]!.n).toBe(0);
    await db.end();
  });

  it.skipIf(process.env["TEST_PG_URL"] !== undefined)(
    "the api project provides snapshots",
    async () => {
      const provided = inject("pgliteSnapshots");
      expect(provided).toBeDefined();
      expect(provided).toHaveProperty("empty");
      expect(provided).toHaveProperty("migrated");
      expect(existsSync(provided!.empty)).toBe(true);
      expect(existsSync(provided!.migrated)).toBe(true);
    },
  );

  test("snapshotKey changes when a migration's SQL changes but its id does not", () => {
    const original = [m("0001_a", "create table a (x int);")];
    const edited = [m("0001_a", "create table a (x int, y int);")];
    const originalKey = snapshotKey(original, "0.5.8");
    const editedKey = snapshotKey(edited, "0.5.8");
    expect(editedKey).not.toBe(originalKey);
    expect(snapshotKey(original, "0.5.8")).toBe(originalKey);
    expect(snapshotKey(original, "0.5.9")).not.toBe(originalKey);
  });

  describe("buildSnapshots reuse and rotation", () => {
    let dir: string;
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    test("reuses files for the same set and writes new files for an edited one", async () => {
      dir = mkdtempSync(join(tmpdir(), "cf-snap-"));
      const migrations = await loadMigrations();
      const first = await buildSnapshots(migrations, dir);
      const mtimeBefore = statSync(first.migrated).mtimeMs;
      const second = await buildSnapshots(migrations, dir);
      const mtimeAfter = statSync(second.migrated).mtimeMs;
      expect(mtimeBefore).toBe(mtimeAfter);
      const edited = migrations.map((mig) =>
        mig.id === "0001_org" ? { ...mig, sql: mig.sql + "\n-- edited" } : mig,
      );
      const third = await buildSnapshots(edited, dir);
      expect(third.migrated).not.toBe(first.migrated);
      expect(existsSync(third.migrated)).toBe(true);
    });
  });

  test("a sequence and a default survive the snapshot dump/load cycle", async () => {
    const db1 = new PGlite();
    await db1.waitReady;
    await db1.exec("create sequence tmp_seq");
    await db1.query("select nextval('tmp_seq') as n");
    // PGlite dumpDataDir does not flush nextval's in-memory advance; sync via setval.
    await db1.exec("select setval('tmp_seq', 1, true)");
    await db1.exec("create table t (val text default 'hello')");
    await db1.query("insert into t default values");
    const dump = await db1.dumpDataDir("none");
    await db1.close();
    const db2 = new PGlite({ loadDataDir: dump });
    await db2.waitReady;
    expect((await db2.query<{ n: number }>("select nextval('tmp_seq') as n")).rows[0]!.n).toBe(2);
    expect((await db2.query<{ val: string }>("select val from t")).rows).toEqual([
      { val: "hello" },
    ]);
    const inserted = await db2.query<{ val: string }>("insert into t default values returning val");
    expect(inserted.rows).toEqual([{ val: "hello" }]);
    await db2.close();
  });

  test("end() releases the instance", async () => {
    const db = await emptyDatabase();
    await db.end();
    await expect(db.query("select 1")).rejects.toThrow();
  });
});
