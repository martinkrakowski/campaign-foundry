import { describe, expect, test } from "vitest";
import { renderStatus } from "../render.js";
import type { LaneStatus, WaveStatus } from "../types.js";

const TS = "2026-09-07T17:00:00Z";

function makeLane(
  lane: string,
  overrides: {
    wave?: string;
    reported?: LaneStatus["reported"];
    alive?: boolean;
    pr?: LaneStatus["derived"]["pr"];
    gate?: LaneStatus["derived"]["gate"];
  } = {},
): LaneStatus {
  return {
    wave: overrides.wave ?? "T",
    lane,
    ...(overrides.reported === undefined ? {} : { reported: overrides.reported }),
    derived: {
      alive: overrides.alive ?? false,
      ...(overrides.pr === undefined ? {} : { pr: overrides.pr }),
      ...(overrides.gate === undefined ? {} : { gate: overrides.gate }),
    },
    disagreements: [],
  };
}

function makeStatus(lanes: readonly LaneStatus[], id = "T"): WaveStatus {
  return { generatedAt: "2026-09-09T00:00:00Z", waves: [{ id, lanes }] };
}

/** Visible length: ANSI SGR sequences occupy columns only in the mind of the painter. */
function visibleLength(line: string): number {
  return line.replace(/\x1b\[[0-9;]*m/g, "").length;
}

describe("renderStatus", () => {
  test("is pure: the same input renders the same string, whatever the environment says", () => {
    const status = makeStatus([
      makeLane("t1", {
        reported: { stage: "review", event: "started", ts: TS, round: 2 },
        pr: { number: 12, state: "open", checks: "pending" },
        gate: { exit: 0, coverage: { statements: 100, branches: 90, functions: 95, lines: 100 } },
        alive: true,
      }),
    ]);
    process.env.COLUMNS = "20";
    let first: string;
    try {
      first = renderStatus(status);
    } finally {
      delete process.env.COLUMNS;
    }
    expect(renderStatus(status)).toBe(first);
  });

  test("a lane with no PR renders —; one with a PR renders its number", () => {
    const out = renderStatus(
      makeStatus([
        makeLane("t1", { pr: { number: 12, state: "open", checks: "pass" }, alive: true }),
        makeLane("t2"),
      ]),
    );
    const rows = out.split("\n");
    const withPr = rows.find((line) => line.includes("T/t1"));
    const withoutPr = rows.find((line) => line.includes("T/t2"));
    expect(withPr).toContain("#12 open pass");
    expect(withoutPr).toMatch(/T\/t2\s+—\s+not alive\s+—\s+—$/);
  });

  test("{ color: false } output contains no ANSI escape — and so does the default", () => {
    const status = makeStatus([
      makeLane("t1", {
        reported: { stage: "gate", event: "failed", ts: TS },
        pr: { number: 7, state: "closed", checks: "fail" },
        gate: { exit: 3 },
        alive: true,
      }),
    ]);
    expect(renderStatus(status, { color: false })).not.toMatch(/\x1b/);
    expect(renderStatus(status)).not.toMatch(/\x1b/);
  });

  test("a narrow width truncates rather than wrapping — no line exceeds it", () => {
    const status = makeStatus([
      makeLane("w1a-implement-past-the-default-width", {
        reported: { stage: "review", event: "settled", ts: TS, round: 1 },
        pr: { number: 1234, state: "open", checks: "pending" },
        gate: { exit: 1, coverage: { statements: 100, branches: 90, functions: 95, lines: 100 } },
        alive: true,
      }),
    ]);
    const full = renderStatus(status);
    expect(full.split("\n").some((line) => line.length > 30)).toBe(true);
    for (const width of [30, 80]) {
      for (const line of renderStatus(status, { width }).split("\n")) {
        expect(line.length).toBeLessThanOrEqual(width);
      }
    }
    // The default is the contract's 100 — and it cuts, it does not wrap.
    for (const line of full.split("\n")) expect(line.length).toBeLessThanOrEqual(100);
    expect(full.split("\n").some((line) => line.length === 100)).toBe(true);
  });

  test("a wave with no lanes renders its heading and no rows, without throwing", () => {
    expect(renderStatus(makeStatus([], "T"))).toBe("wave T");
  });

  test("a status with no waves renders nothing", () => {
    expect(renderStatus({ generatedAt: "2026-09-09T00:00:00Z", waves: [] })).toBe("");
  });

  test("each wave renders its own block, separated by a blank line", () => {
    const out = renderStatus({
      generatedAt: "2026-09-09T00:00:00Z",
      waves: [
        { id: "T", lanes: [makeLane("t1", { alive: true })] },
        { id: "U", lanes: [makeLane("u1", { wave: "U" })] },
      ],
    });
    expect(out.split("\n")).toEqual([
      "wave T",
      expect.stringContaining("lane"),
      expect.stringContaining("T/t1"),
      "",
      "wave U",
      expect.stringContaining("lane"),
      expect.stringContaining("U/u1"),
    ]);
  });

  test("a reported round renders with the stage; its absence renders without one", () => {
    const out = renderStatus(
      makeStatus([
        makeLane("t1", { reported: { stage: "gate", event: "started", ts: TS, round: 0 } }),
        makeLane("t2", { reported: { stage: "gate", event: "started", ts: TS } }),
      ]),
    );
    expect(out).toContain("gate started (round 0)");
    expect(out).toMatch(/gate started {2,}/);
  });

  test("the gate column renders exit and coverage, or — when either is missing", () => {
    const out = renderStatus(
      makeStatus([
        makeLane("t1", { gate: { exit: 0, coverage: { statements: 98, branches: 95, functions: 97, lines: 98 } } }),
        makeLane("t2", { gate: { exit: 3 } }),
        makeLane("t3", { gate: {} }),
        makeLane("t4", { gate: { coverage: { statements: 50, branches: 60, functions: 70, lines: 80 } } }),
      ]),
    );
    expect(out).toContain("exit 0 · 98/95/97/98%");
    expect(out).toContain("exit 3\n");
    expect(out).toContain("· 50/60/70/80%");
    expect(out).toMatch(/T\/t3\s+—\s+not alive\s+—\s+—$/m);
  });

  test("colour is opt-in and paints the page's tones", () => {
    const status = makeStatus([
      makeLane("t1", { reported: { stage: "gate", event: "failed", ts: TS } }),
      makeLane("t2", {
        reported: { stage: "review", event: "settled", ts: TS },
        alive: true,
        pr: { number: 13, state: "merged", checks: "none" },
      }),
      makeLane("t3", {
        reported: { stage: "dispatch", event: "started", ts: TS },
        alive: true,
        pr: { number: 14, state: "open", checks: "pass" },
      }),
      makeLane("t4", {
        alive: true,
        pr: { number: 15, state: "closed", checks: "fail" },
        gate: { exit: 2 },
      }),
      makeLane("t5", {
        alive: true,
        pr: { number: 16, state: "open", checks: "pending" },
        gate: { exit: 0, coverage: { statements: 98, branches: 95, functions: 97, lines: 98 } },
      }),
      makeLane("t6", { alive: true, gate: { coverage: { statements: 50, branches: 60, functions: 70, lines: 80 } } }),
    ]);
    const out = renderStatus(status, { color: true });
    expect(out).toContain("\x1b[31m"); // red: failed, closed, fail, exit 2
    expect(out).toContain("\x1b[32m"); // green: settled, merged, pass, alive, exit 0
    expect(out).toContain("\x1b[33m"); // yellow: pending
    expect(out).toContain("\x1b[36m"); // cyan: started, open
    expect(out).toContain("\x1b[2m"); // dim: header, absent cells, not alive
    expect(out).toContain("\x1b[0m"); // reset after every painted span
  });

  test("a truncated coloured line keeps its escapes whole and ends reset", () => {
    const out = renderStatus(makeStatus([makeLane("t1", { alive: true })]), {
      color: true,
      width: 6,
    });
    for (const line of out.split("\n")) {
      expect(visibleLength(line)).toBeLessThanOrEqual(6);
    }
    expect(out).toContain("\x1b[0m");
  });

  test("a lane name containing a bare escape character is data, not a colour code", () => {
    const out = renderStatus(makeStatus([makeLane("e\x1bb", { alive: true })]), {
      color: true,
      width: 40,
    });
    expect(out).toContain("e\x1bb");
    for (const line of out.split("\n")) {
      expect(visibleLength(line)).toBeLessThanOrEqual(40);
    }
  });
});
