import { PGlite } from "@electric-sql/pglite";
import { afterAll, inject } from "vitest";
import type { DatabaseConfig } from "../database-config.js";
import { loadMigrations, migrate } from "../migrate.js";
import { pgClient } from "../pg-client.js";
import type { SqlClient } from "../sql-client.js";
import { pglitePgPool } from "./pglite-pg-pool.js";
import { snapshotBlob, sqlClientOver } from "./pglite-snapshot.js";
import {
  authServerDatabase,
  emptyServerDatabase,
  leakedDatabases,
  migratedServerDatabase,
  testDatabaseBackend,
  type AuthDatabase,
} from "./test-database.js";

/**
 * A real Postgres, for tests: PGlite in process by default, or a real server
 * when `TEST_PG_URL` names one (D186).
 *
 * PGlite is a real Postgres compiled to WebAssembly, so the suite needs no
 * server and never reaches a hosted database. It is one connection, so it cannot
 * test two writers racing (PT-6 needs a real server for that), and on a slow
 * host its start-up alone exceeds the 5 s test budget. When `TEST_PG_URL` is
 * set, the three constructors below hand out databases on that server instead —
 * a migrated copy of one template, or a fresh empty one — and everything else
 * about a test is unchanged.
 *
 * Unset or empty, `TEST_PG_URL` is the whole of the difference: the server code
 * is never reached, and PGlite behaves exactly as it always has.
 *
 * PGlite starts from a saved data directory when the api project's globalSetup
 * provided one.
 */
function pgliteInstance(snapshot?: "empty" | "migrated"): PGlite {
  const path = snapshot === undefined ? undefined : inject("pgliteSnapshots")?.[snapshot];
  const options = path === undefined ? undefined : { loadDataDir: snapshotBlob(path) };
  return new PGlite(options);
}

export function pgliteClient(snapshot?: "empty" | "migrated"): SqlClient {
  return sqlClientOver(pgliteInstance(snapshot));
}

/** A fresh database with every shipped migration applied. */
export async function migratedDatabase(): Promise<SqlClient> {
  if (testDatabaseBackend() === "server") return migratedServerDatabase();
  const provided = inject("pgliteSnapshots");
  if (provided?.migrated) return pgliteClient("migrated");
  const db = pgliteClient();
  await migrate(db, await loadMigrations());
  return db;
}

/**
 * A fresh database with NO migration applied — for the tests that apply their
 * own, or a chosen prefix of them, to a database they control.
 */
export async function emptyDatabase(): Promise<SqlClient> {
  if (testDatabaseBackend() === "server") return emptyServerDatabase();
  return pgliteClient("empty");
}

/**
 * An empty database plus the pool Better Auth is handed, as one value.
 *
 * The four Better Auth sites each built that pair themselves out of a
 * `new PGlite()`, a `pglitePgPool()` double and a `pgClient()` over it, always
 * empty, always with their own `migrate()` on top. This is the same thing
 * chosen by `TEST_PG_URL` instead of written out four times, and `sql` is over
 * the SAME `pool` on both backends — so a test can query through `pgClient()`
 * and watch the rows Better Auth wrote, which is the whole point of
 * `schema-agreement.test.ts`'s proof.
 */
export async function authDatabase(): Promise<AuthDatabase> {
  if (testDatabaseBackend() === "server") return authServerDatabase();
  const pool = pglitePgPool(pgliteInstance("empty"));
  return {
    pool,
    sql: pgClient(DUMMY_CONFIG, () => pool),
    end: () => pool.end(),
  };
}

/**
 * Never used to connect: `pgClient`'s `makePool` override replaces the real
 * `pg.Pool` this would otherwise build with the PGlite double, but `pgClient`
 * still reads the config's shape.
 */
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
 * Every database this file handed out has been dropped, as `tenant-harness.ts`
 * asserts of its temporary directories. On PGlite `end()` closes the instance
 * and there is nothing on a server to leak, so this is the server's assertion
 * only.
 */
afterAll(async () => {
  if (testDatabaseBackend() !== "server") return;
  const leaked = await leakedDatabases();
  if (leaked.length > 0) {
    throw new Error(
      `Leaked ${leaked.length} test database(s) for pid ${process.pid}:\n${leaked.join("\n")}`,
    );
  }
});
