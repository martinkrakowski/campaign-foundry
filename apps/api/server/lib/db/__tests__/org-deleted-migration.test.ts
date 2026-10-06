import { describe, test, expect } from "vitest";
import { emptyDatabase } from "./pglite-client.js";
import { loadMigrations, migrate } from "../migrate.js";

const MIGRATION = "0018_org_deleted_at";

/**
 * Claims about the shape of the `0018` migration itself (PT-9m1, D241, OD1):
 * these tests are NOT about any reader — they pin that the column is nullable,
 * has no default, is `timestamptz`, and that an org column naming an operator
 * (`deleted_by`) was deliberately NOT added. Each later lane may change the
 * shape only with its own migration; a silent edit here would be caught.
 */
describe("0018 org deleted_at migration", () => {
  test("org deleted_at migration adds a nullable timestamptz column with no default", async () => {
    const db = await emptyDatabase();
    try {
      const all = await loadMigrations();
      await migrate(
        db,
        all.filter((m) => m.id < MIGRATION),
      );

      const applied = await migrate(db, all);
      expect(applied).toContain(MIGRATION);

      const { rows } = await db.query<{
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `select data_type, is_nullable, column_default
           from information_schema.columns
          where table_name = 'org' and column_name = 'deleted_at'`,
      );
      expect(rows).toEqual([
        { data_type: "timestamp with time zone", is_nullable: "YES", column_default: null },
      ]);

      // OD1: no `deleted_by` column on the org (the actor lives on the `deletion`
      // row, which 9m2 anonymises). Its absence is a shape claim, not a guess.
      const { rows: deletedBy } = await db.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_name = 'org' and column_name = 'deleted_by'`,
      );
      expect(deletedBy).toEqual([]);
    } finally {
      await db.end();
    }
  });

  test("org deleted_at migration leaves every existing org live including local", async () => {
    const db = await emptyDatabase();
    try {
      const all = await loadMigrations();
      await migrate(
        db,
        all.filter((m) => m.id < MIGRATION),
      );

      await db.query(`insert into org (id, name) values ('pre-migration', 'Pre')`);

      const applied = await migrate(db, all);
      expect(applied).toContain(MIGRATION);

      const { rows: before } = await db.query<{ id: string; deleted_at: Date | null }>(
        `select id, deleted_at from org order by id`,
      );
      // No backfill: every existing row reads null, including `local`.
      expect(before).toEqual([
        { id: "local", deleted_at: null },
        { id: "pre-migration", deleted_at: null },
      ]);

      await db.query(`update org set deleted_at = now() where id = 'pre-migration'`);
      const { rows: after } = await db.query<{ id: string; deleted_at: Date | null }>(
        `select id, deleted_at from org order by id`,
      );
      expect(after[0]!.deleted_at).toBeNull();
      expect(after[1]!.deleted_at).not.toBeNull();
    } finally {
      await db.end();
    }
  });
});
