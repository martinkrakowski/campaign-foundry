import { describe, test, expect } from "vitest";
import { DEFAULT_REQUEST_TIMEOUT_MS, requestSignal } from "../request-deadline.js";

/**
 * R5, D77/L13 — the composition itself, rather than only its type at the call
 * sites. A reviewer pointed out that asserting `instanceof AbortSignal` in each
 * adapter says the wiring exists but nothing about the ceiling actually firing.
 *
 * Real timers with a tiny explicit ceiling, deliberately: `AbortSignal.timeout`
 * schedules where fake timers cannot reach it, so a fake-timer test here would
 * assert nothing and look green.
 */
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("requestSignal", () => {
  test("the ceiling fires on its own, with no run to bound", async () => {
    const signal = requestSignal(undefined, 5);
    expect(signal.aborted).toBe(false);
    await tick(25);
    expect(signal.aborted).toBe(true);
  });

  test("the run's abort fires it early, before the ceiling would", async () => {
    const run = new AbortController();
    const signal = requestSignal(run.signal, 10_000);
    expect(signal.aborted).toBe(false);
    run.abort(new Error("run abandoned"));
    expect(signal.aborted).toBe(true);
    // The reason survives composition, so a caller can still tell the two
    // apart — an abandoned run is not the same event as a slow upstream.
    expect((signal.reason as Error).message).toBe("run abandoned");
  });

  test("a live run does not keep a request alive past its ceiling", async () => {
    // The direction that matters for L5: one hung socket inside a healthy run.
    const run = new AbortController();
    const signal = requestSignal(run.signal, 5);
    await tick(25);
    expect(signal.aborted).toBe(true);
    expect(run.signal.aborted).toBe(false);
  });

  test("the default ceiling is the house 30 s, not per-adapter invention", () => {
    // Copied from `OpenRouterCopyGenerator`, which has had one all along —
    // these adapters simply never got one (L5).
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(30_000);
  });
});
