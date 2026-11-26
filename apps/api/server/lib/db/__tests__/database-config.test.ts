import { describe, test, expect, vi } from "vitest";
import {
  DEFAULT_POOL_MAX,
  MAX_POOL,
  AUTH_POOL_MAX,
  databaseConfig,
  poolBudget,
} from "../database-config.js";

const remote = "postgres://app_user:s3cr%40t@db.example.test:12194/defaultdb?sslmode=require";
const noCa = (): string => {
  throw new Error("no CA should be read");
};

describe("databaseConfig (D174a)", () => {
  test("a remote database is reached over TLS that verifies its certificate against the given CA", () => {
    const readCa = vi.fn(() => "-----BEGIN CERTIFICATE-----");
    expect(databaseConfig({ url: remote, caPath: "certs/ca.pem" }, readCa)).toEqual({
      host: "db.example.test",
      port: 12194,
      user: "app_user",
      password: "s3cr@t",
      database: "defaultdb",
      ssl: { ca: "-----BEGIN CERTIFICATE-----", rejectUnauthorized: true },
      max: DEFAULT_POOL_MAX,
    });
    expect(readCa).toHaveBeenCalledWith("certs/ca.pem");
  });

  test("a remote database without a CA is refused, naming the setting and never the password", () => {
    const run = () => databaseConfig({ url: remote }, noCa);
    expect(run).toThrow(/DATABASE_CA_PATH is not set/);
    expect(run).toThrow(/db\.example\.test/);
    expect(run).not.toThrow(/s3cr/);
  });

  test("a local database needs no CA, and takes the default port", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      const config = databaseConfig({ url: `postgresql://me@${host}/cf` }, noCa);
      expect(config.ssl).toBe(false);
      expect(config.port).toBe(5432);
      expect(config.password).toBe("");
    }
    // An IPv6 literal reaches the driver without its URL brackets.
    expect(databaseConfig({ url: "postgres://me@[::1]/cf" }, noCa).host).toBe("::1");
  });

  test("a local database given a CA verifies against it too", () => {
    const config = databaseConfig(
      { url: "postgres://me@localhost/cf", caPath: "ca.pem" },
      () => "PEM",
    );
    expect(config.ssl).toEqual({ ca: "PEM", rejectUnauthorized: true });
  });

  test("DATABASE_POOL_MAX bounds the pool; empty is the default; anything else is refused", () => {
    const local = "postgres://me@localhost/cf";
    expect(databaseConfig({ url: local, poolMax: "3" }, noCa).max).toBe(3);
    expect(
      databaseConfig({ url: local, poolMax: String(MAX_POOL - AUTH_POOL_MAX) }, noCa).max,
    ).toBe(MAX_POOL - AUTH_POOL_MAX);
    expect(databaseConfig({ url: local, poolMax: "" }, noCa).max).toBe(DEFAULT_POOL_MAX);
    for (const bad of ["0", "14", "15", "16", "2.5", "many"]) {
      expect(() => databaseConfig({ url: local, poolMax: bad }, noCa)).toThrow(/DATABASE_POOL_MAX/);
    }
  });

  test("DATABASE_POOL_MAX + AUTH_POOL_MAX above MAX_POOL is refused to protect per-process budget", () => {
    const local = "postgres://me@localhost/cf";
    expect(databaseConfig({ url: local, poolMax: "13" }, noCa).max).toBe(13);
    expect(() => databaseConfig({ url: local, poolMax: "14" }, noCa)).toThrow(
      `DATABASE_POOL_MAX (14) + AUTH_POOL_MAX (2) exceeds DATABASE_POOL_CEILING (15).`,
    );
  });

  test("unset or empty poolMax, authPoolMax and poolCeiling all return their defaults", () => {
    const local = "postgres://me@localhost/cf";
    expect(poolBudget({})).toEqual({ poolMax: 5, authPoolMax: 2, ceiling: 15 });
    expect(poolBudget({ poolMax: "", authPoolMax: "", poolCeiling: "" })).toEqual({
      poolMax: 5,
      authPoolMax: 2,
      ceiling: 15,
    });
    expect(databaseConfig({ url: local }, noCa).max).toBe(DEFAULT_POOL_MAX);
  });

  test("a custom DATABASE_POOL_CEILING is honoured, freeing room for a larger store pool", () => {
    const local = "postgres://me@localhost/cf";
    expect(poolBudget({ poolMax: "28", poolCeiling: "30" })).toEqual({
      poolMax: 28,
      authPoolMax: 2,
      ceiling: 30,
    });
    expect(databaseConfig({ url: local, poolMax: "28", poolCeiling: "30" }, noCa).max).toBe(28);
  });

  test("a custom AUTH_POOL_MAX + DATABASE_POOL_MAX within the ceiling is honoured", () => {
    const local = "postgres://me@localhost/cf";
    expect(poolBudget({ poolMax: "3", authPoolMax: "4" })).toEqual({
      poolMax: 3,
      authPoolMax: 4,
      ceiling: 15,
    });
    expect(databaseConfig({ url: local, poolMax: "3", authPoolMax: "4" }, noCa).max).toBe(3);
  });

  test("an over-budget pair is refused, against the default ceiling and a custom one", () => {
    const local = "postgres://me@localhost/cf";
    expect(() => poolBudget({ poolMax: "14", authPoolMax: "2" })).toThrow(
      `DATABASE_POOL_MAX (14) + AUTH_POOL_MAX (2) exceeds DATABASE_POOL_CEILING (15).`,
    );
    expect(() => poolBudget({ poolMax: "28", authPoolMax: "3", poolCeiling: "30" })).toThrow(
      `DATABASE_POOL_MAX (28) + AUTH_POOL_MAX (3) exceeds DATABASE_POOL_CEILING (30).`,
    );
    expect(() => databaseConfig({ url: local, poolMax: "14" }, noCa)).toThrow(/exceeds/);
  });

  test("non-integer or < 1 DATABASE_POOL_CEILING is refused", () => {
    for (const bad of ["0", "-1", "2.5", "many", "   "]) {
      expect(() => poolBudget({ poolCeiling: bad })).toThrow(
        `DATABASE_POOL_CEILING must be a whole number of at least 1, not "${bad}".`,
      );
    }
  });

  test("non-integer or < 1 AUTH_POOL_MAX is refused", () => {
    for (const bad of ["0", "-1", "1.5", "many", "   "]) {
      expect(() => poolBudget({ authPoolMax: bad })).toThrow(
        `AUTH_POOL_MAX must be a whole number of at least 1, not "${bad}".`,
      );
    }
  });

  test("non-integer or < 1 DATABASE_POOL_MAX is refused", () => {
    for (const bad of ["0", "-1", "2.5", "many", "   "]) {
      expect(() => poolBudget({ poolMax: bad })).toThrow(
        `DATABASE_POOL_MAX must be a whole number of at least 1, not "${bad}".`,
      );
    }
  });

  test("a missing, malformed or incomplete URL is refused", () => {
    expect(() => databaseConfig({}, noCa)).toThrow("DATABASE_URL is not set.");
    expect(() => databaseConfig({ url: "not a url" }, noCa)).toThrow("DATABASE_URL is not a URL.");
    expect(() => databaseConfig({ url: "mysql://me@localhost/cf" }, noCa)).toThrow(/postgres:\/\//);
    expect(() => databaseConfig({ url: "postgres://localhost/cf" }, noCa)).toThrow(/a user/);
    expect(() => databaseConfig({ url: "postgres://me@localhost/" }, noCa)).toThrow(/a database/);
  });
});
