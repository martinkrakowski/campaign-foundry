import { afterEach, describe, expect, test, vi } from "vitest";

describe("wait-scale", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  test("the wait scale is 3 under CI, 1 elsewhere, and the variable overrides both", async () => {
    // Under CI, with no numeric override, the scale is the loaded-runner default.
    vi.stubEnv("CI", "true");
    vi.stubEnv("CF_GATE_TEST_WAIT_SCALE", "");
    vi.resetModules();
    expect((await import("./wait-scale.js")).WAIT_SCALE).toBe(3);

    // Not CI, no override: the idle-machine default.
    vi.stubEnv("CI", "");
    vi.resetModules();
    expect((await import("./wait-scale.js")).WAIT_SCALE).toBe(1);

    // An override wins over CI, even when CI is set.
    vi.stubEnv("CI", "true");
    vi.stubEnv("CF_GATE_TEST_WAIT_SCALE", "5");
    vi.resetModules();
    expect((await import("./wait-scale.js")).WAIT_SCALE).toBe(5);

    // ...and wins over the idle default too.
    vi.stubEnv("CI", "");
    vi.resetModules();
    expect((await import("./wait-scale.js")).WAIT_SCALE).toBe(5);
  });

  test("a variable that is not a number of at least 1 is ignored", async () => {
    vi.stubEnv("CI", "true");

    // 0 is a number but not at least 1 — fall back to the CI default.
    vi.stubEnv("CF_GATE_TEST_WAIT_SCALE", "0");
    vi.resetModules();
    expect((await import("./wait-scale.js")).WAIT_SCALE).toBe(3);

    // 1 is the smallest valid value — it overrides, even under CI.
    vi.stubEnv("CF_GATE_TEST_WAIT_SCALE", "1");
    vi.resetModules();
    expect((await import("./wait-scale.js")).WAIT_SCALE).toBe(1);

    // Not a number at all — ignored.
    vi.stubEnv("CF_GATE_TEST_WAIT_SCALE", "abc");
    vi.resetModules();
    expect((await import("./wait-scale.js")).WAIT_SCALE).toBe(3);
  });

  test("scaled stretches a millisecond value by the wait scale", async () => {
    vi.stubEnv("CF_GATE_TEST_WAIT_SCALE", "3");
    vi.resetModules();
    const { scaled } = await import("./wait-scale.js");
    expect(scaled(40)).toBe(120);

    vi.stubEnv("CI", "");
    vi.stubEnv("CF_GATE_TEST_WAIT_SCALE", "");
    vi.resetModules();
    const { scaled: scaledIdle } = await import("./wait-scale.js");
    expect(scaledIdle(40)).toBe(40);
  });
});
