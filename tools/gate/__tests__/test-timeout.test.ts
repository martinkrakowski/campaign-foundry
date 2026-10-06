import { afterEach, describe, expect, test, vi } from "vitest";
import {
  MAX_HOST_TEST_TIMEOUT_MS,
  MIN_HOST_TEST_TIMEOUT_MS,
  resolveTestTimeout,
} from "../lib/test-timeout.js";

/**
 * `CF_TEST_TIMEOUT_MS`, the host-wide lift of vitest's test and hook timeouts.
 *
 * The helper is pure and takes its env as an argument. The second describe is
 * the wiring: `vitest.config.ts` is IMPORTED with the variable stubbed and read
 * back, because a one-line call is what a tidy-up deletes, and a grep is
 * satisfied by the comment that survives it.
 */

const env = (raw: string): NodeJS.ProcessEnv => ({ CF_TEST_TIMEOUT_MS: raw });

describe("resolveTestTimeout", () => {
  test("an unset variable answers undefined so vitest keeps its own limits", () => {
    expect(resolveTestTimeout({})).toBeUndefined();
  });

  test("a whole number of milliseconds is passed through as the timeout", () => {
    expect(resolveTestTimeout(env("30000"))).toBe(30000);
  });

  test("the smallest and the largest allowed values are accepted", () => {
    expect(resolveTestTimeout(env(String(MIN_HOST_TEST_TIMEOUT_MS)))).toBe(10000);
    expect(resolveTestTimeout(env(String(MAX_HOST_TEST_TIMEOUT_MS)))).toBe(600000);
  });

  test.each([[""], ["30s"], ["3e4"], [" 30000 "], ["30000.5"], ["-30000"], ["0x7530"]])(
    "refuses '%s' as not a whole number of milliseconds, naming the variable",
    (raw) => {
      expect(() => resolveTestTimeout(env(raw))).toThrowError(
        `CF_TEST_TIMEOUT_MS must be a whole number of milliseconds, got '${raw}'`,
      );
    },
  );

  test("a value below the hook default is refused because it would shorten a hook", () => {
    expect(() => resolveTestTimeout(env("9999"))).toThrowError(
      "CF_TEST_TIMEOUT_MS=9999 is outside 10000–600000 ms",
    );
  });

  test("a value above ten minutes is refused", () => {
    expect(() => resolveTestTimeout(env("600001"))).toThrowError(
      "CF_TEST_TIMEOUT_MS=600001 is outside 10000–600000 ms",
    );
  });
});

describe("vitest.config.ts host timeout wiring", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const webProject = (cfg: { test?: { projects?: unknown[] } }) =>
    (cfg.test?.projects ?? [])
      .map((project) => (project as { test?: { name?: string; testTimeout?: number } }).test)
      .find((project) => project?.name === "web");

  test("the host timeout reaches testTimeout and hookTimeout when the variable is set", async () => {
    vi.stubEnv("CF_TEST_TIMEOUT_MS", "30000");
    vi.resetModules();
    // Extensionless, as max-workers.test.ts imports this same config.
    const { default: cfg } = await import("../../../vitest.config");
    expect(cfg.test?.testTimeout).toBe(30000);
    expect(cfg.test?.hookTimeout).toBe(30000);
  });

  test("testTimeout and hookTimeout stay undefined when the variable is unset", async () => {
    vi.stubEnv("CF_TEST_TIMEOUT_MS", undefined);
    vi.resetModules();
    const { default: cfg } = await import("../../../vitest.config");
    expect(cfg.test?.testTimeout).toBeUndefined();
    expect(cfg.test?.hookTimeout).toBeUndefined();
  });

  test("the web project keeps its own 15 seconds when the variable is unset", async () => {
    vi.stubEnv("CF_TEST_TIMEOUT_MS", undefined);
    vi.resetModules();
    const { default: cfg } = await import("../../../vitest.config");
    expect(webProject(cfg)?.testTimeout).toBe(15000);
  });

  test("the web project takes the host timeout when it is the larger one", async () => {
    vi.stubEnv("CF_TEST_TIMEOUT_MS", "30000");
    vi.resetModules();
    const { default: cfg } = await import("../../../vitest.config");
    expect(webProject(cfg)?.testTimeout).toBe(30000);
  });

  test("the web project keeps its own 15 seconds when the host timeout is smaller", async () => {
    vi.stubEnv("CF_TEST_TIMEOUT_MS", "10000");
    vi.resetModules();
    const { default: cfg } = await import("../../../vitest.config");
    expect(webProject(cfg)?.testTimeout).toBe(15000);
  });
});
