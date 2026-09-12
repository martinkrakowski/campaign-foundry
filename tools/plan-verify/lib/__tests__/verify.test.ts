import { describe, expect, test } from "vitest";
import type { Premise } from "../types.js";
import { EXIT_ALL_HOLD, EXIT_STALE_FOUND, exitCodeFor, formatReport, verifyPremises } from "../verify.js";

const premise = (lane: string, script = "true"): Premise => ({ plan: "p.md", lane, script });

const execWith = (codes: Record<string, number>, output = "") =>
  async (script: string) => ({ exitCode: codes[script] ?? 0, output });

describe("verifyPremises", () => {
  test("exit 0 means the gap is still open, so the lane holds", async () => {
    const r = await verifyPremises([premise("W1", "open")], { execute: execWith({ open: 0 }) });
    expect(r[0]?.status).toBe("holds");
  });

  test("a non-zero exit means the gap is closed and the lane is stale", async () => {
    const r = await verifyPremises([premise("W4", "closed")], { execute: execWith({ closed: 1 }) });
    expect(r[0]).toMatchObject({ status: "stale", exitCode: 1 });
  });

  test("runs every premise and preserves order", async () => {
    const r = await verifyPremises([premise("A", "a"), premise("B", "b")], {
      execute: execWith({ a: 0, b: 1 }),
    });
    expect(r.map((x) => [x.premise.lane, x.status])).toEqual([["A", "holds"], ["B", "stale"]]);
  });
});

describe("formatReport", () => {
  test("names a stale lane, its plan, and says not to dispatch it", async () => {
    const r = await verifyPremises([premise("M4", "closed")], { execute: execWith({ closed: 1 }) });
    const text = formatReport(r);
    expect(text).toContain("STALE  M4  (p.md)");
    expect(text).toContain("already closed");
    expect(text).toContain("Do not dispatch it");
  });

  test("includes the script's own output when it produced any", async () => {
    const r = await verifyPremises([premise("M4", "closed")], {
      execute: execWith({ closed: 1 }, "already memoized in prepare"),
    });
    expect(formatReport(r)).toContain("already memoized in prepare");
  });

  test("says plainly when nothing is stale", async () => {
    const r = await verifyPremises([premise("W1", "open")], { execute: execWith({ open: 0 }) });
    expect(formatReport(r)).toBe("1 premise(s) hold; no lane is stale.");
  });

  test("counts both sides when some are stale", async () => {
    const r = await verifyPremises([premise("A", "a"), premise("B", "b")], {
      execute: execWith({ a: 0, b: 1 }),
    });
    expect(formatReport(r)).toContain("1 stale, 1 holding.");
  });
});

describe("exitCodeFor", () => {
  test("is non-zero when any premise is stale, so CI can refuse", async () => {
    const r = await verifyPremises([premise("A", "a"), premise("B", "b")], {
      execute: execWith({ a: 0, b: 1 }),
    });
    expect(exitCodeFor(r)).toBe(EXIT_STALE_FOUND);
  });

  test("is zero when every premise holds", async () => {
    const r = await verifyPremises([premise("A", "a")], { execute: execWith({ a: 0 }) });
    expect(exitCodeFor(r)).toBe(EXIT_ALL_HOLD);
  });
});
