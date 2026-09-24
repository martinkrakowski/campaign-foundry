import { PGlite } from "@electric-sql/pglite";
import { loadMigrations, migrate } from "../migrate.js";
import type { SqlClient, SqlQuery, SqlRows } from "../sql-client.js";

/**
 * A real Postgres, in process (PGlite): what every database test runs against,
 * so the suite needs no server and never reaches the owner's Aiven service.
 * One instance per test (or file); PGlite is a single connection, so it cannot
 * test two writers racing (PT-6 needs a real server for that).
 */
export function pgliteClient(): SqlClient {
  const db = new PGlite();
  const over = (run: Pick<PGlite, "query" | "exec">): SqlQuery => ({
    query: async <R>(text: string, params?: readonly unknown[]) =>
      (await run.query<R>(text, params === undefined ? undefined : [...params])) as SqlRows<R>,
    exec: async (text: string) => {
      await run.exec(text);
    },
  });
  return {
    ...over(db),
    transaction: (work) => db.transaction((tx) => work(over(tx))),
    end: () => db.close(),
  };
}

/** A fresh database with every shipped migration applied. */
export async function migratedDatabase(): Promise<SqlClient> {
  const db = pgliteClient();
  await migrate(db, await loadMigrations());
  return db;
}
