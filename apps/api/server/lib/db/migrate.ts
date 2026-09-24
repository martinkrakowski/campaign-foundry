import { createHash } from "node:crypto";
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

/** What a database records of a migration's SQL, so an edit after it is applied is caught. */
export function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

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
 * migration this code does not ship (it is ahead, e.g. after a rollback), one
 * missing a migration that sorts before one it has (they were applied out of
 * order), or one whose record of an applied migration's SQL differs from the file
 * (the file was edited after it ran: a fresh database would get a different schema).
 * A change to an applied migration is a new migration.
 */
export async function migrate(db: SqlClient, migrations: readonly Migration[]): Promise<string[]> {
  return db.transaction(async (tx) => {
    await tx.query("select pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
    await tx.exec(
      "create table if not exists schema_migrations (id text primary key, checksum text not null, applied_at timestamptz not null default now())",
    );
    const recorded = (
      await tx.query<{ id: string; checksum: string }>("select id, checksum from schema_migrations")
    ).rows;
    const applied = new Set(recorded.map((r) => r.id));
    const known = new Set(migrations.map((m) => m.id));
    const edited = recorded
      .filter((r) => {
        const shipped = migrations.find((m) => m.id === r.id);
        return shipped !== undefined && checksum(shipped.sql) !== r.checksum;
      })
      .map((r) => r.id)
      .sort();
    if (edited.length > 0) {
      throw new Error(
        `Applied migrations were edited since they ran: ${edited.join(", ")}. Ship a change as a new migration.`,
      );
    }
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
      await tx.query("insert into schema_migrations (id, checksum) values ($1, $2)", [
        migration.id,
        checksum(migration.sql),
      ]);
    }
    return pending.map((m) => m.id);
  });
}
