import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { SqlClient } from "../../db/sql-client.js";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import { deleteOrgRows } from "../purge-org.js";
import { seedOrg } from "../../deletion/__tests__/purge-org-fixtures.js";

/**
 * W3 (no source change): every table that has an `org_id` column is either
 * deleted by `deleteOrgRows` or deliberately kept. This file discovers the set
 * of org-scoped tables by querying `information_schema` — so a new table added
 * without updating `LEFTOVER_TABLES` FAILS test 14, naming the missing table.
 */

const KEPT: Record<string, string> = {
  campaign:
    "removed by the campaign purges; purgeOrg answers retry while any row remains (purge-org.ts count)",
  usage: "billing evidence kept 13 months, D241",
  deletion: "the work queue itself; requested_by is anonymised, rows kept",
} as const;

async function orgScopedTables(db: SqlClient): Promise<string[]> {
  const { rows } = await db.query<{ t: string }>(
    `select c.table_name as t from information_schema.columns c
       join information_schema.tables x on x.table_schema = c.table_schema and x.table_name = c.table_name
     where c.column_name = 'org_id' and c.table_schema = current_schema() and x.table_type = 'BASE TABLE'
     order by 1`,
  );
  return rows.map((r) => r.t);
}

/** Build a recording proxy: every statement its transaction sees is captured, so
 * the tables `deleteOrgRows` actually deletes from are OBSERVED, not inferred
 * from `LEFTOVER_TABLES`. The five inline deletes (`provider_key`, `team`,
 * `invitation`, `member`, and the `team_member` subquery) are captured too. */
async function deletedTables(db: SqlClient): Promise<Set<string>> {
  const seen: string[] = [];
  const proxy: SqlClient = {
    ...db,
    transaction: (work) =>
      db.transaction((tx) =>
        work({
          ...tx,
          query: async <R>(text: string, params?: readonly unknown[]) => {
            seen.push(text);
            return tx.query<R>(text, params);
          },
        }),
      ),
  };
  await seedOrg(db, "acme", undefined, { campaigns: 0 });
  await deleteOrgRows(proxy, "acme");
  const deleted = new Set<string>();
  for (const text of seen) {
    const match = /^\s*delete from ([a-z_]+) where org_id = \$1/.exec(text);
    if (match) deleted.add(match[1]!);
  }
  return deleted;
}

/** Tables in `orgScoped` that are neither KEPT nor deleted — the undeclared ones. */
function undeclared(orgScoped: readonly string[], deleted: Set<string>): string[] {
  return orgScoped.filter((t) => !(t in KEPT) && !deleted.has(t));
}

describe("deleteOrgRows table coverage (FU-purge-org-hardening, W3)", () => {
  let db: SqlClient;

  beforeEach(async () => {
    db = await migratedDatabase();
  });
  afterEach(async () => {
    await db.end();
  });

  test("every org-scoped table is either deleted by deleteOrgRows or deliberately kept", async () => {
    const orgScoped = await orgScopedTables(db);
    const deleted = await deletedTables(db);
    const missing = undeclared(orgScoped, deleted);
    expect(missing).toEqual([]);
  });

  test("the kept list names no table that is also deleted and no table that has no org_id", async () => {
    const deleted = await deletedTables(db);
    // deleted and KEPT do not intersect
    expect(Object.keys(KEPT).filter((t) => deleted.has(t))).toEqual([]);
    // each KEPT key is in orgScopedTables (a stale allow-list entry fails)
    const orgScoped = await orgScopedTables(db);
    const missing = Object.keys(KEPT).filter((t) => !orgScoped.includes(t));
    expect(missing).toEqual([]);
  });

  test("the check reports a new org-scoped table that nobody declared", async () => {
    const db2 = await migratedDatabase();
    try {
      await db2.query(`create table zz_unlisted (org_id text)`);
      const orgScoped = await orgScopedTables(db2);
      const deleted = await deletedTables(db2);
      const missing = undeclared(orgScoped, deleted);
      expect(missing).toEqual(["zz_unlisted"]);
    } finally {
      await db2.end();
    }
  });
});
