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

/**
 * The env as a host running the shared gate pool sees it: no per-project
 * variable at all, and the host's worker budget in its place.
 */
const poolEnv = (raw: string): NodeJS.ProcessEnv => ({ GATE_HOST_WORKERS: raw });

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

  // GATE_HOST_WORKERS is the host-wide budget of a host that runs the shared
  // gate pool, and this is the only place a vitest run learns about it. Every
  // message names whichever variable actually supplied the value, because the
  // operator who has to fix it is the one who set that one — a message that said
  // CF_TEST_MAX_WORKERS on a host that only sets GATE_HOST_WORKERS would send
  // them to edit a variable nobody set.
  describe("GATE_HOST_WORKERS, the fallback on a host that runs the pool", () => {
    test("it is the worker count when CF_TEST_MAX_WORKERS is unset", () => {
      expect(resolveMaxWorkers(poolEnv("4"), CPUS)).toBe(4);
    });

    test("CF_TEST_MAX_WORKERS still wins when it is set, and the two are not compared", () => {
      // Byte for byte today's behaviour: a project that sets its own cap keeps
      // it, for the one release in which the project variables are kept. The
      // comparison between the two lives in scripts/gate-lock.sh, which is the
      // layer that knows whether this run is on a pool at all — refusing here
      // would break the host during exactly the migration the pool is for.
      expect(resolveMaxWorkers({ CF_TEST_MAX_WORKERS: "2", GATE_HOST_WORKERS: "4" }, CPUS)).toBe(2);
    });

    test("a CF_TEST_MAX_WORKERS that is set but unusable is refused, not answered from the host", () => {
      // It was set, so it is the value — and an empty one is a variable the
      // operator believes they set. Falling through to GATE_HOST_WORKERS here
      // would make a typo look like it worked. The asymmetry with GATE_HOST_WORKERS
      // below is deliberate and is what the empty-value rule says: a project
      // variable is the operator's own hand, and a host variable is a wrapper's.
      expect(() =>
        resolveMaxWorkers({ CF_TEST_MAX_WORKERS: "", GATE_HOST_WORKERS: "4" }, CPUS),
      ).toThrowError(/CF_TEST_MAX_WORKERS must be a positive whole number, got ''/);
    });

    test("an empty GATE_HOST_WORKERS is unset, exactly as an absent one", () => {
      // The host variable has the OPPOSITE rule, and the fold has to carry it. An
      // empty value counts as unset for every one of gate-lock.sh's pool
      // variables, and the thing that exports "" is the wrapper a host sets up to
      // be explicit about having nothing to say. Read as a value instead, `""`
      // reaches the validation below and the config throws at load on a host that
      // has configured nothing at all — which is the one host that cannot run a
      // test suite.
      expect(resolveMaxWorkers({ GATE_HOST_WORKERS: "" }, CPUS)).toEqual(
        resolveMaxWorkers({}, CPUS),
      );
      expect(resolveMaxWorkers({ GATE_HOST_WORKERS: "" }, CPUS)).toBeUndefined();
      // And the empty host variable never displaces a project's own: the project
      // variable is read first, and "" is not "absent" there.
      expect(resolveMaxWorkers({ CF_TEST_MAX_WORKERS: "3", GATE_HOST_WORKERS: "" }, CPUS)).toBe(3);
    });

    test.each([
      ["0", "zero workers is not a cap, it is a run that starts nothing"],
      ["4.5", "a fractional worker does not exist"],
      ["x", "a non-number is a typo, and guessing at it is worse than refusing"],
    ])("refuses '%s': %s — naming the variable that supplied it", (raw, _why) => {
      expect(() => resolveMaxWorkers(poolEnv(raw), CPUS)).toThrowError(/GATE_HOST_WORKERS/);
    });

    test("a count above the CPU count is refused, naming GATE_HOST_WORKERS", () => {
      // The same rule as above, read from the other variable — and the one that
      // matters on the pool: this host may be running in a cpuset, so the value
      // an operator wrote for the machine is not the thread count this process
      // can see, and quietly clamping it would oversubscribe whatever is left.
      expect(() => resolveMaxWorkers(poolEnv("25"), CPUS)).toThrowError(
        /GATE_HOST_WORKERS=25 is above this host's availableParallelism\(\) \(24\)/,
      );
    });
  });
});

describe("vitest.config.ts", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  test("the cap reaches test.maxWorkers when CF_TEST_MAX_WORKERS is set", async () => {
    // "1", not "3": the stub goes through the SAME validation a real host
    // setting does, so a value above this host's availableParallelism() throws
    // inside the import and the test fails on a 1- or 2-vCPU runner (a
    // cpuset-limited container, a private-repo runner) for a reason that has
    // nothing to do with the wiring. "1" is below every host's CPU count, and is
    // still distinct from `undefined`, so a deleted or commented-out
    // `maxWorkers` line is still caught.
    vi.stubEnv("CF_TEST_MAX_WORKERS", "1");
    // The host's own budget is stubbed to UNDEFINED as well, and that is the
    // second half of this wiring: a host that has adopted the shared gate pool
    // exports GATE_HOST_WORKERS, and with only CF_TEST_MAX_WORKERS stubbed the
    // config would answer from the host's value and this case would pass on a
    // machine where the wiring does not exist at all.
    vi.stubEnv("GATE_HOST_WORKERS", undefined);
    vi.resetModules();
    // Extensionless, as gate.test.ts imports this same config: a `.ts`
    // specifier is TS5097 under this repo's tsconfig, and the resolution that
    // matters here is vite's, which finds the file either way.
    const { default: cfg } = await import("../../../vitest.config");
    expect(cfg.test?.maxWorkers).toBe(1);
  });

  test("maxWorkers stays undefined when the variable is unset", async () => {
    vi.stubEnv("CF_TEST_MAX_WORKERS", undefined);
    // And GATE_HOST_WORKERS too, or this case reads the operator's host rather
    // than "unset" — on midnight, where it is 4.
    vi.stubEnv("GATE_HOST_WORKERS", undefined);
    vi.resetModules();
    const { default: cfg } = await import("../../../vitest.config");
    expect(cfg.test?.maxWorkers).toBeUndefined();
  });

  test("the host's GATE_HOST_WORKERS reaches maxWorkers when the project sets none", async () => {
    // The other direction of the same wiring, and the one the pool depends on: a
    // host that exports GATE_HOST_WORKERS and no CF_TEST_MAX_WORKERS is a host
    // whose every project gets the same capped worker count. Stubbed through the
    // env rather than by hand, so the value passes the same validation.
    vi.stubEnv("CF_TEST_MAX_WORKERS", undefined);
    vi.stubEnv("GATE_HOST_WORKERS", "1");
    vi.resetModules();
    const { default: cfg } = await import("../../../vitest.config");
    expect(cfg.test?.maxWorkers).toBe(1);
  });
});
