/**
 * A scale factor that stretches only HOW LONG a handshake-wait test waits
 * before it gives up, so a deadline that is generous on an idle machine is
 * still generous on a loaded one.
 *
 * Read once, at import time, from the environment:
 *   - `CF_GATE_TEST_WAIT_SCALE` when it is a finite number of at least 1;
 *   - otherwise 3 when `CI` is set and non-empty (a loaded CI runner);
 *   - otherwise 1 (an interactive or idle machine).
 *
 * It NEVER changes what a test accepts. It does not touch any value the
 * SCRIPT under test is given (a heartbeat interval, a stale age, a
 * `CF_GATE_*` variable, a `sleep` inside a command the test launches), and
 * it does not weaken an assertion on an exit code, file contents, or a budget
 * that exists only to reject a signal forwarded too late. It multiplies how
 * long a wait lasts; it does not move what a wait is waiting for.
 */

function envScale(): number {
  const raw = process.env.CF_GATE_TEST_WAIT_SCALE;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1) return n;
  }
  if (process.env.CI !== undefined && process.env.CI !== "") {
    return 3;
  }
  return 1;
}

export const WAIT_SCALE: number = envScale();

/** `ms` stretched by the scale, rounded to the millisecond the poll loop reads. */
export function scaled(ms: number): number {
  return Math.round(ms * WAIT_SCALE);
}
