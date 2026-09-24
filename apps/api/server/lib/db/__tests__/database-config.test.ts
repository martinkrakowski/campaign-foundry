import { describe, test, expect, vi } from "vitest";
import { DEFAULT_POOL_MAX, databaseConfig } from "../database-config.js";

const remote =
  "postgres://avnadmin:s3cr%40t@db.example.aivencloud.com:12194/defaultdb?sslmode=require";
const noCa = (): string => {
  throw new Error("no CA should be read");
};

describe("databaseConfig (D174a)", () => {
  test("a remote database is reached over TLS that verifies its certificate against the given CA", () => {
    const readCa = vi.fn(() => "-----BEGIN CERTIFICATE-----");
    expect(databaseConfig({ url: remote, caPath: "certs/ca.pem" }, readCa)).toEqual({
      host: "db.example.aivencloud.com",
      port: 12194,
      user: "avnadmin",
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
    expect(run).toThrow(/db\.example\.aivencloud\.com/);
    expect(run).not.toThrow(/s3cr/);
  });

  test("a local database needs no CA, and takes the default port", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      const config = databaseConfig({ url: `postgresql://me@${host}/cf` }, noCa);
      expect(config.ssl).toBe(false);
      expect(config.port).toBe(5432);
      expect(config.password).toBe("");
    }
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
    expect(databaseConfig({ url: local, poolMax: "" }, noCa).max).toBe(DEFAULT_POOL_MAX);
    for (const bad of ["0", "101", "2.5", "many"]) {
      expect(() => databaseConfig({ url: local, poolMax: bad }, noCa)).toThrow(/DATABASE_POOL_MAX/);
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
