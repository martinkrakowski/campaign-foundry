/** Vitest's own default hook timeout: a host value below it would SHORTEN a hook. */
export const MIN_HOST_TEST_TIMEOUT_MS = 10_000;

/** Ten minutes. Above it a hung test is indistinguishable from a slow one. */
export const MAX_HOST_TEST_TIMEOUT_MS = 600_000;

/**
 * The per-test and per-hook timeout for ONE vitest run on a slow host:
 * `CF_TEST_TIMEOUT_MS` if the HOST sets it, `undefined` otherwise.
 *
 * It exists for one host. On midnight (an old CPU, no AVX2) a PGlite start costs
 * 5.2–6.5 s (`apps/api/server/lib/db/__tests__/test-database.ts`), which is at or
 * past vitest's 5 s default before the test has done anything, so the in-memory
 * database tests there are noise: they time out on unmodified code, and more often
 * the busier the host is. The variable is set HOST-WIDE beside
 * `CF_TEST_MAX_WORKERS`, never per seat and never in a brief.
 *
 * Unset is the default and means unset: CI and the Mac pass nothing and keep
 * vitest's own limits, byte for byte. That is the point of the rule this file does
 * NOT relax — a slowdown is never answered by raising the committed timeout,
 * because the 5 s limit on CI is what notices a test that became slow. This lifts
 * the limit on a host that says it is slow, and nowhere else.
 *
 * It can only LIFT: a value below {@link MIN_HOST_TEST_TIMEOUT_MS} is refused,
 * since the same number is applied to hooks and vitest's hook default is 10 s. It
 * does not save a `cpu-bound` test, which fails on its own internal deadline.
 *
 * The env is an argument, not an ambient read, so the tests state their own.
 */
export function resolveTestTimeout(host: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = host["CF_TEST_TIMEOUT_MS"];
  if (raw === undefined) return undefined;

  // Not `Number(raw)`: that accepts "3e4", " 30000 " and "0x7530", and an empty
  // string as 0. A variable the operator believes they set is refused by name.
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `CF_TEST_TIMEOUT_MS must be a whole number of milliseconds, got '${raw}'. ` +
        `It lifts the test and hook timeout on a slow HOST, so it is set host-wide, never per seat.`,
    );
  }

  const ms = Number(raw);
  if (ms < MIN_HOST_TEST_TIMEOUT_MS || ms > MAX_HOST_TEST_TIMEOUT_MS) {
    throw new Error(
      `CF_TEST_TIMEOUT_MS=${raw} is outside ${MIN_HOST_TEST_TIMEOUT_MS}–${MAX_HOST_TEST_TIMEOUT_MS} ms. ` +
        `It may only lift the limits (vitest's hook default is ${MIN_HOST_TEST_TIMEOUT_MS} ms); ` +
        `unset it to get vitest's own.`,
    );
  }

  return ms;
}
