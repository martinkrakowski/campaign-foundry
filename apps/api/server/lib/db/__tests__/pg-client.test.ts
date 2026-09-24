import { describe, test, expect, vi } from "vitest";
import type { DatabaseConfig } from "../database-config.js";
import { pgClient, type PgConnection, type PgPool } from "../pg-client.js";

const config: DatabaseConfig = {
  host: "localhost",
  port: 5432,
  user: "me",
  password: "",
  database: "cf",
  ssl: false,
  max: 2,
};

function fakePool(connectionFails?: (text: string) => boolean) {
  const statements: string[] = [];
  let onError: ((error: Error) => void) | undefined;
  const connection: PgConnection & { released: number } = {
    released: 0,
    query: vi.fn(async (text: string) => {
      statements.push(text);
      if (connectionFails?.(text)) throw new Error(`failed: ${text}`);
      return { rows: [] };
    }),
    release() {
      this.released += 1;
    },
  };
  const pool: PgPool = {
    query: vi.fn(async (text: string, params?: unknown[]) => ({ rows: [{ text, params }] })),
    connect: vi.fn(async () => connection),
    end: vi.fn(async () => undefined),
    on: (_event, listener) => {
      onError = listener;
    },
  };
  return { pool, connection, statements, fail: (e: Error) => onError!(e) };
}

describe("pgClient", () => {
  test("builds its pool from the config and connects nothing until a statement runs", () => {
    const { pool } = fakePool();
    const make = vi.fn(() => pool);
    pgClient(config, make);
    expect(make).toHaveBeenCalledWith(config);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test("query passes the statement and a copy of its parameters; exec sends the script unparameterised", async () => {
    const { pool } = fakePool();
    const db = pgClient(config, () => pool);
    const params = [1, "a"] as const;
    expect((await db.query("select $1, $2", params)).rows).toEqual([
      { text: "select $1, $2", params: [1, "a"] },
    ]);
    await db.query("select 1");
    await db.exec("create table a (); create table b ();");
    expect(pool.query).toHaveBeenLastCalledWith("create table a (); create table b ();");
    await db.end();
    expect(pool.end).toHaveBeenCalled();
  });

  test("a transaction commits what resolves, on one connection, and releases it", async () => {
    const { pool, connection, statements } = fakePool();
    const db = pgClient(config, () => pool);
    const result = await db.transaction(async (tx) => {
      await tx.query("insert into t values ($1)", [1]);
      await tx.exec("select 1; select 2");
      return "done";
    });
    expect(result).toBe("done");
    expect(statements).toEqual([
      "BEGIN",
      "insert into t values ($1)",
      "select 1; select 2",
      "COMMIT",
    ]);
    expect(connection.released).toBe(1);
  });

  test("a transaction that throws is rolled back, released, and rethrows its own error even if the rollback fails", async () => {
    const { pool, connection, statements } = fakePool((text) => text === "ROLLBACK");
    const db = pgClient(config, () => pool);
    await expect(
      db.transaction(async () => {
        throw new Error("work failed");
      }),
    ).rejects.toThrow("work failed");
    expect(statements).toEqual(["BEGIN", "ROLLBACK"]);
    expect(connection.released).toBe(1);
  });

  test("an idle connection's failure is reported, not left to crash the process", () => {
    const { pool, fail } = fakePool();
    pgClient(config, () => pool);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fail(new Error("server closed the connection"));
    expect(warn).toHaveBeenCalledWith(
      "[db] an idle connection failed: server closed the connection",
    );
    warn.mockRestore();
  });

  test("the default pool is a real pg.Pool, built lazily from the config", async () => {
    await pgClient({ ...config, ssl: { ca: "PEM", rejectUnauthorized: true } }).end(); // never connected
    await pgClient(config).end();
  });
});
