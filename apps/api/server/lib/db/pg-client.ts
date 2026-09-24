import pg from "pg";
import type { DatabaseConfig } from "./database-config.js";
import type { SqlClient, SqlQuery, SqlRows } from "./sql-client.js";

/** The part of a `pg` connection the client uses. */
export interface PgConnection {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  on(event: "error", listener: (error: Error) => void): unknown;
  removeListener(event: "error", listener: (error: Error) => void): unknown;
  /** `true` destroys the connection instead of returning it to the pool. */
  release(destroy?: boolean): void;
}

/** The part of a `pg.Pool` the client uses, so tests can hand in a double. */
export interface PgPool {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  connect(): Promise<PgConnection>;
  end(): Promise<void>;
  on(event: "error", listener: (error: Error) => void): unknown;
}

/** How long a connection may take to open before the statement waiting on it fails. */
export const CONNECT_TIMEOUT_MS = 10_000;

/** The `pg.Pool` options a config becomes. */
export function poolOptions(config: DatabaseConfig): pg.PoolConfig {
  return {
    ...config,
    ssl: config.ssl === false ? false : { ...config.ssl },
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  };
}

const realPool = (config: DatabaseConfig): PgPool => new pg.Pool(poolOptions(config));

function over(run: PgPool | PgConnection): SqlQuery {
  return {
    query: async <R>(text: string, params?: readonly unknown[]) =>
      (await run.query(text, params === undefined ? undefined : [...params])) as SqlRows<R>,
    // Unparameterised, so `pg` sends it over the simple protocol, which runs every
    // statement in the script.
    exec: async (text: string) => {
      await run.query(text);
    },
  };
}

/**
 * A `SqlClient` over a bounded `pg` pool. The pool connects lazily, on the first
 * statement, so building a client opens nothing.
 */
export function pgClient(
  config: DatabaseConfig,
  makePool: (config: DatabaseConfig) => PgPool = realPool,
): SqlClient {
  const pool = makePool(config);
  // An idle connection the server drops emits `error` on the pool; unhandled, it
  // would crash the process. The next statement reconnects.
  pool.on("error", (error) => {
    console.warn(`[db] an idle connection failed: ${error.message}`);
  });
  return {
    ...over(pool),
    async transaction<T>(work: (tx: SqlQuery) => Promise<T>): Promise<T> {
      const connection = await pool.connect();
      // A connection the server drops mid-transaction emits `error` on the checked-out
      // client, which the pool's listener does not see. It, or a rollback that fails,
      // leaves the connection's state unknown: it is destroyed, never pooled again.
      let broken = false;
      const onError = () => {
        broken = true;
      };
      connection.on("error", onError);
      try {
        await connection.query("BEGIN");
        const result = await work(over(connection));
        await connection.query("COMMIT");
        return result;
      } catch (error) {
        // A failed rollback must not hide the error that caused it.
        await connection.query("ROLLBACK").catch(() => {
          broken = true;
        });
        throw error;
      } finally {
        connection.removeListener("error", onError);
        connection.release(broken);
      }
    },
    end: () => pool.end(),
  };
}
