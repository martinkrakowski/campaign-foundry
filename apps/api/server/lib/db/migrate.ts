import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SqlClient } from "./sql-client.js";

/** One schema change: `NNNN_name.sql` in `migrations/`. */
export interface Migration {
  readonly id: string;
  readonly sql: string;
}

/** The migrations this code ships. */
export const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations", import.meta.url));

const MIGRATION_NAME = /^(\d{4}_[a-z0-9_]+)\.sql$/;

/** Any number, so long as every process migrating this database uses the same one. */
const MIGRATION_LOCK = 7_210_431;

/** The migrations in `dir`, in order. A `.sql` file not named `NNNN_name.sql` is refused. */
export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  const migrations: Migration[] = [];
  for (const name of names) {
    const match = MIGRATION_NAME.exec(name);
    if (!match) throw new Error(`Migration ${name} is not named NNNN_name.sql.`);
    migrations.push({ id: match[1]!, sql: await readFile(join(dir, name), "utf8") });
  }
  return migrations;
}

/**
 * Apply the migrations the database has not seen, in order, in one transaction
 * held under an advisory lock, so two processes migrating at once apply each
 * migration once, and a failure applies none. Answers the ids it applied.
 *
 * Refuses a database this code cannot reason about: one that has applied a
 * migration this code does not ship (it is ahead, e.g. after a rollback), or one
 * missing a migration that sorts before one it has (they were applied out of order).
 */
export async function migrate(db: SqlClient, migrations: readonly Migration[]): Promise<string[]> {
  return db.transaction(async (tx) => {
    await tx.query("select pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
    await tx.exec(
      "create table if not exists schema_migrations (id text primary key, applied_at timestamptz not null default now())",
    );
    const applied = new Set(
      (await tx.query<{ id: string }>("select id from schema_migrations")).rows.map((r) => r.id),
    );
    const known = new Set(migrations.map((m) => m.id));
    const unknown = [...applied].filter((id) => !known.has(id)).sort();
    if (unknown.length > 0) {
      throw new Error(
        `The database has applied migrations this code does not ship: ${unknown.join(", ")}.`,
      );
    }
    const pending = migrations.filter((m) => !applied.has(m.id));
    const latest = [...applied].sort().at(-1);
    const early = pending.find((m) => latest !== undefined && m.id < latest);
    if (early) {
      throw new Error(`Migration ${early.id} sorts before ${latest}, which is already applied.`);
    }
    for (const migration of pending) {
      await tx.exec(migration.sql);
      await tx.query("insert into schema_migrations (id) values ($1)", [migration.id]);
    }
    return pending.map((m) => m.id);
  });
}
