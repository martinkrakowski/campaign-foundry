import type { PGlite } from "@electric-sql/pglite";
import type { PgConnection, PgPool } from "../pg-client.js";

/**
 * The leading SQL keyword, uppercased: what `pg` reports as a result's `command`,
 * and what Kysely's Postgres driver reads (alongside `rowCount`) to decide whether
 * a result carries an affected-row count (`numAffectedRows` is set only for
 * INSERT/UPDATE/DELETE/MERGE). PGlite's result carries neither field, so this
 * double derives both from the statement text.
 */
function commandOf(sql: string): string {
  const match = /^\s*(\w+)/.exec(sql);
  return match ? match[1]!.toUpperCase() : "";
}

/**
 * Better Auth against PGlite (PT-1a, D174b(2)): the schema-agreement test proves
 * Better Auth's own Kysely adapter can run against the database our migrations
 * ship. Better Auth's adapter duck-types its `database` option
 * (`getKyselyDatabaseType`, `@better-auth/kysely-adapter`): an object with a
 * `connect` method is detected as Postgres and wrapped in Kysely's own
 * `PostgresDialect`, whose driver expects a `pg.Pool`-shaped object — `connect()`
 * returning a client with `query`/`release`, plus `query`, `end` and `on` on the
 * pool itself. PGlite is a single embedded connection, not a pool, so every
 * `connect()` here hands out a client backed by the same instance; PGlite
 * serialises its own calls, so this is safe for the single-writer tests this
 * double exists for (PT-6's two-writer race needs a real server, unchanged).
 *
 * This is the same `PgPool`/`PgConnection` shape `pg-client.ts` builds from a real
 * `pg.Pool` in production, so a caller (Better Auth, or a test using Kysely
 * directly) cannot tell the two apart.
 */
export function pglitePgPool(db: PGlite): PgPool {
  const run = async (text: string, params?: unknown[]) => {
    // `pg`'s simple protocol (no params: our own `SqlQuery.exec`, and a bare
    // `SqlQuery.query(text)`) runs every statement in the text; PGlite's own
    // analogue is `exec`, not `query`, which refuses more than one statement
    // ("cannot insert multiple commands into a prepared statement" — it always
    // prepares). Kysely never calls without parameters (it compiles one
    // statement per call, with an always-present, possibly empty, parameters
    // array), so this branch is exactly our own multi-statement callers.
    if (params === undefined) {
      const results = await db.exec(text);
      const last = results.at(-1);
      return {
        rows: last?.rows ?? [],
        rowCount: last?.affectedRows ?? null,
        command: commandOf(text),
      };
    }
    const result = await db.query<Record<string, unknown>>(text, params);
    return { rows: result.rows, rowCount: result.affectedRows ?? null, command: commandOf(text) };
  };
  const connection = {
    query: run,
    on: (): unknown => connection,
    removeListener: (): unknown => connection,
    release: (): void => {},
  };
  const pool = {
    query: run,
    connect: async (): Promise<PgConnection> => connection,
    end: (): Promise<void> => db.close(),
    on: (): unknown => pool,
    // Kysely's own `PostgresPool` type (not `PgPool`, ours) declares this;
    // nothing in the paths these tests exercise reads it — only the
    // cancel-query fallback in `postgres-driver.js` does.
    options: {},
  };
  return pool;
}
