import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveMaxWorkers } from "../lib/max-workers.js";

/**
 * Lane HXF8 — `CF_TEST_MAX_WORKERS`, the per-run vitest worker cap.
 *
 * The helper is pure and takes its env and its CPU count as arguments, so every
 * case here states the host it means instead of inheriting whichever one the
 * test happens to run on. That is what lets the "above the CPU count" case
 * exist at all on a 24-thread box: there is no host-sensitivity to trigger it
 * naturally, and a test that could only run on a 2-core machine would skip
 * exactly where the setting is most likely to be wrong.
 *
 * The second describe is the wiring. `vitest.config.ts` calling the helper is
 * one line, and a line like that is what a refactor, a merge or a well-meaning
 * tidy deletes — after which every run on the host silently goes back to
 * `availableParallelism() - 1` workers per slot, and the oversubscription this
 * lane exists to stop returns with no red anywhere. So the config is IMPORTED
 * here with the variable stubbed and read back. A grep would not do: a comment
 * mentioning `maxWorkers` satisfies a grep perfectly, and the comment is the
 * likeliest thing to survive the deletion.
 */

const CPUS = 24;

/** The env as the helper sees it, with CF_TEST_MAX_WORKERS set to `raw`. */
const env = (raw: string): NodeJS.ProcessEnv => ({ CF_TEST_MAX_WORKERS: raw });

describe("resolveMaxWorkers", () => {
  test("an unset variable returns undefined, so vitest's own default applies", () => {
    expect(resolveMaxWorkers({}, CPUS)).toBeUndefined();
  });

  test("a whole number is passed through as the worker count", () => {
    expect(resolveMaxWorkers(env("4"), CPUS)).toBe(4);
  });

  test("a count equal to the CPU count is accepted", () => {
    expect(resolveMaxWorkers(env("24"), CPUS)).toBe(24);
  });

  test.each([
    ["0", "zero workers is not a cap, it is a run that starts nothing"],
    ["-1", "a negative count is nonsense, not a small pool"],
    ["4.5", "a fractional worker does not exist"],
    ["", "an empty value is a variable the operator believes they set"],
    ["x", "a non-number is a typo, and guessing at it is worse than refusing"],
    [" 4 ", "whitespace around a count means something else was typed"],
    ["0x4", "a hexadecimal count is a different number wearing the same digits"],
  ])("refuses '%s': %s", (raw, _why) => {
    expect(() => resolveMaxWorkers(env(raw), CPUS)).toThrowError(/CF_TEST_MAX_WORKERS/);
  });

  test("a count above the CPU count is refused, and the message says why", () => {
    // The cap exists to keep slots × workers inside the host's threads. A value
    // past the thread count measures as no cap at all while reading as a
    // deliberate one, so it is refused rather than clamped to something the
    // operator did not ask for.
    expect(() => resolveMaxWorkers(env("25"), CPUS)).toThrowError(
      /CF_TEST_MAX_WORKERS=25 is above this host's availableParallelism\(\) \(24\)/,
    );
  });
});

describe("vitest.config.ts", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  test("the cap reaches test.maxWorkers when CF_TEST_MAX_WORKERS is set", async () => {
    vi.stubEnv("CF_TEST_MAX_WORKERS", "3");
    vi.resetModules();
    // Extensionless, as gate.test.ts imports this same config: a `.ts`
    // specifier is TS5097 under this repo's tsconfig, and the resolution that
    // matters here is vite's, which finds the file either way.
    const { default: cfg } = await import("../../../vitest.config");
    expect(cfg.test?.maxWorkers).toBe(3);
  });

  test("maxWorkers stays undefined when the variable is unset", async () => {
    vi.stubEnv("CF_TEST_MAX_WORKERS", undefined);
    vi.resetModules();
    const { default: cfg } = await import("../../../vitest.config");
    expect(cfg.test?.maxWorkers).toBeUndefined();
  });
});
