import { describe, test, expect } from "vitest";
import { databaseConfig } from "../database-config.js";
import { testServerConfig } from "./test-server-config.js";

/**
 * The harness-only config helper that lets a listed private host stand in for a
 * loopback test server. Every case here runs with NO server: `env -u TEST_PG_URL`
 * in CI's replay legs and in `test-server-config.test.ts` itself.
 */
describe("testServerConfig", () => {
  test("loopback URL with an empty allow-list returns a local config", () => {
    const url = "postgres://cf_test@127.0.0.1:5433/postgres";
    const config = testServerConfig({ url }, "TEST_PG_URL");
    const baseline = databaseConfig({ url }, () => {
      throw new Error("a local TEST_PG_URL needs no CA");
    });

    expect(config).toEqual(baseline);
    expect(config.host).toBe("127.0.0.1");
    expect(config.ssl).toBe(false);
  });

  test("a listed private host connects over loopback with ssl false", () => {
    const url = "postgres://cf_test@10.60.0.1:5434/cf_home";
    const config = testServerConfig({ url }, "TEST_PG_URL", "10.60.0.1");

    expect(config.host).toBe("10.60.0.1");
    expect(config.port).toBe(5434);
    expect(config.user).toBe("cf_test");
    expect(config.database).toBe("cf_home");
    expect(config.ssl).toBe(false);
  });

  test("a host that is not listed is refused even with a non-empty allow-list", () => {
    const url = "postgres://cf_test@10.60.0.2:5434/cf_home";
    expect(() => testServerConfig({ url }, "TEST_PG_URL", "10.60.0.1")).toThrow(
      /TEST_PG_URL names a remote database, and the test harness only reaches a local test server\./,
    );
  });

  test("an empty allow-list still refuses a private host", () => {
    const url = "postgres://cf_test@10.60.0.1:5434/cf_home";
    expect(() => testServerConfig({ url }, "TEST_PG_URL", "")).toThrow(
      /TEST_PG_URL names a remote database, and the test harness only reaches a local test server\./,
    );
  });

  test("a non-private TEST_PG_ALLOW_HOSTS entry throws at read time, even for a loopback URL", () => {
    const url = "postgres://cf_test@127.0.0.1:5433/postgres";
    const cases: [string, string][] = [
      ["8.8.8.8", "8.8.8.8"],
      ["db.example.com", "db.example.com"],
      ["10.60.0.*", "10.60.0.*"],
      ["10.0.0.0/8", "10.0.0.0/8"],
      ["*", "*"],
      ["10.60.0.1,", ""],
    ];
    for (const [list, expected] of cases) {
      expect(() => testServerConfig({ url }, "TEST_PG_URL", list)).toThrow(
        `TEST_PG_ALLOW_HOSTS entry "${expected}" is not a private IPv4 address`,
      );
    }
  });

  test("a public URL host is refused even when a private host is listed", () => {
    const url = "postgres://cf_test@8.8.8.8:5434/cf_home";
    expect(() => testServerConfig({ url }, "TEST_PG_URL", "10.60.0.1")).toThrow(
      /TEST_PG_URL names a remote database, and the test harness only reaches a local test server\./,
    );
  });

  test("a URL with an encoded password round-trips and is never echoed in an error", () => {
    const config = testServerConfig(
      { url: "postgres://cf_test:p%40ss@10.60.0.1:5434/cf_home" },
      "TEST_PG_URL",
      "10.60.0.1",
    );
    expect(config.password).toBe(decodeURIComponent("p%40ss"));
    expect(config.password).toBe("p@ss");

    let caught: Error | undefined;
    try {
      testServerConfig(
        { url: "postgres://cf_test:p%40ss@8.8.8.8:5434/cf_home" },
        "TEST_PG_URL",
        "10.60.0.1",
      );
    } catch (e) {
      caught = e instanceof Error ? e : undefined;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).not.toContain("p%40ss");
    expect(caught!.message).not.toContain("p@ss");
  });

  test("the refusal names the env variable the caller read", () => {
    const remote = "postgres://cf_test@8.8.8.8:5434/cf_home";
    expect(() => testServerConfig({ url: remote }, "TEST_PG_URL")).toThrow(
      /TEST_PG_URL names a remote database, and the test harness only reaches a local test server\./,
    );
    expect(() => testServerConfig({ url: remote }, "TEST_DATABASE_URL")).toThrow(
      /TEST_DATABASE_URL names a remote database, and the test harness only reaches a local test server\./,
    );
  });
});
