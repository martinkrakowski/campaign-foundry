import {
  laneState,
  laneStateCounts,
  stallThresholdMs,
  LANE_STATES,
  NEEDS_HUMAN_STATES,
  isNeedsHumanState,
} from "../lane-state";
import type { LaneStatus } from "../types.js";
import { it, expect } from "vitest";

type PartialLaneStatus = Partial<LaneStatus> & {
  derived?: Partial<LaneStatus["derived"]>;
  disagreements?: string[];
};

function makeStatus(overrides: PartialLaneStatus = {}): LaneStatus {
  const base: LaneStatus = {
    wave: "test",
    lane: "test",
    disagreements: [],
    derived: {
      alive: false,
    },
  };
  const derived = { ...base.derived, ...overrides.derived } as any;
  return {
    ...base,
    ...overrides,
    derived,
  } as any as LaneStatus;
}

const now = Date.now();

// Helper to set log mtime
function withLog(status: LaneStatus, mtime: number): LaneStatus {
  return {
    ...status,
    derived: {
      ...status.derived,
      log: { bytes: 0, mtimeMs: mtime, tail: "" },
    },
  };
}

// Tests for each state

it("conflict", () => {
  const s = makeStatus({ disagreements: ["a"] });
  expect(laneState(s, now)).toBe("conflict");
});

it("failed", () => {
  const s = makeStatus({ derived: { exit: 1, alive: false } });
  expect(laneState(s, now)).toBe("failed");
});

it("stalled", () => {
  const s = makeStatus({ derived: { alive: true } });
  const s2 = withLog(s, now - stallThresholdMs - 1);
  expect(laneState(s2, now)).toBe("stalled");
});

it("running", () => {
  const s = makeStatus({ derived: { alive: true } });
  const s2 = withLog(s, now - stallThresholdMs + 1);
  expect(laneState(s2, now)).toBe("running");
});

it("boundary: log mtime exactly at stall threshold is running (< reads strictly older)", () => {
  const s = makeStatus({ derived: { alive: true } });
  const s2 = withLog(s, now - stallThresholdMs);
  expect(laneState(s2, now)).toBe("running");
});

it("vanished", () => {
  const s = makeStatus({});
  expect(laneState(s, now)).toBe("vanished");
});

// The silent no-op exits 0: a run that billed and produced nothing.
// A lane that is not alive and has no PR is vanished, whatever its exit code.
it("vanished when exit is zero and not alive (silent no-op)", () => {
  const s = makeStatus({ derived: { alive: false, exit: 0 } });
  expect(laneState(s, now)).toBe("vanished");
});

it("blocked", () => {
  const s = makeStatus({
    derived: {
      alive: false,
      pr: { number: 1, state: "open", checks: "pending" },
    },
  });
  expect(laneState(s, now)).toBe("blocked");
});

// Every PR spends its first few seconds exactly like this: it exists, and CI
// has reported nothing yet. `checks: "none"` is waiting for a verdict that has
// not started — the same thing `blocked` already names — not a throw.
it("open PR with checks none is blocked, not an unhandled state", () => {
  const s = makeStatus({
    derived: {
      alive: false,
      pr: { number: 1, state: "open", checks: "none" },
    },
  });
  expect(laneState(s, now)).toBe("blocked");
});

// The collector does hand back closed PRs, and the ranking has no verdict for
// one. Name the gap instead of guessing a state: an unnamed state is a
// question, a wrong state is a lie.
it("closed PR is unknown, not a guess", () => {
  const s = makeStatus({
    derived: {
      alive: false,
      pr: { number: 1, state: "closed", checks: "none" },
    },
  });
  expect(laneState(s, now)).toBe("unknown");
});

it("merged PR with checks none is still merged", () => {
  const s = makeStatus({
    derived: {
      alive: false,
      pr: { number: 1, state: "merged", checks: "none" },
    },
  });
  expect(laneState(s, now)).toBe("merged");
});

it("ready", () => {
  const s = makeStatus({
    derived: {
      alive: false,
      pr: { number: 1, state: "open", checks: "pass" },
    },
  });
  expect(laneState(s, now)).toBe("ready");
});

it("merged", () => {
  const s = makeStatus({
    derived: {
      alive: false,
      pr: { number: 1, state: "merged", checks: "pass" },
    },
  });
  expect(laneState(s, now)).toBe("merged");
});

 // gate.exit non-zero without derived.exit -> failed
 it("gate.exit non-zero without derived.exit -> failed", () => {
   const s = makeStatus({ derived: { alive: false, gate: { exit: 1 } } });
   expect(laneState(s, now)).toBe("failed");
 });
 // gate.exit non-zero with derived.exit === 0 -> failed
 it("gate.exit non-zero with derived.exit === 0 -> failed", () => {
   const s = makeStatus({ derived: { alive: false, exit: 0, gate: { exit: 2 } } });
   expect(laneState(s, now)).toBe("failed");
 });
 // pr.checks fail on open PR -> failed
 it("pr.checks fail on open PR -> failed", () => {
   const s = makeStatus({ derived: { alive: false, pr: { number: 1, state: "open", checks: "fail" } } });
   expect(laneState(s, now)).toBe("failed");
 });
 // failed outranks blocked and ready
 it("failed outranks blocked and ready", () => {
   const s = makeStatus({ derived: { alive: false, gate: { exit: 1 }, pr: { number: 1, state: "open", checks: "pending" } } });
   expect(laneState(s, now)).toBe("failed");
 });
 // Precedence tests

it("conflict overrides failed", () => {
  const s = makeStatus({
    disagreements: ["a"],
    derived: { exit: 1, alive: false },
  });
  expect(laneState(s, now)).toBe("conflict");
});

it("conflict overrides running", () => {
  const s = makeStatus({
    disagreements: ["a"],
    derived: { alive: true },
  });
  expect(laneState(s, now)).toBe("conflict");
});

it("failed overrides running", () => {
  const s = makeStatus({
    derived: { exit: 1, alive: true },
  });
  expect(laneState(s, now)).toBe("failed");
});

it("stalled overrides running", () => {
  const s = makeStatus({
    derived: { alive: true },
  });
  const s2 = withLog(s, now - stallThresholdMs - 1);
  expect(laneState(s2, now)).toBe("stalled");
});

// The rollup: per-wave and page counts are `laneStateCounts` over the lanes,
// bucketed by `laneState` — the very function the row's leading cell reads. So
// the count of `running` here is the count of rows that will render `running`,
// by construction: one computation, not two that must be kept in step.
it("laneStateCounts buckets every state once each, keyed by LANE_STATES", () => {
  const oneOfEach: LaneStatus[] = [
    makeStatus({ disagreements: ["a"] }), // conflict
    makeStatus({ derived: { alive: false, exit: 1 } }), // failed
    withLog(makeStatus({ derived: { alive: true } }), now - stallThresholdMs - 1), // stalled
    withLog(makeStatus({ derived: { alive: true } }), now - stallThresholdMs + 1), // running
    makeStatus({ derived: { alive: false } }), // vanished
    makeStatus({ derived: { alive: false, pr: { number: 1, state: "open", checks: "pending" } } }), // blocked
    makeStatus({ derived: { alive: false, pr: { number: 1, state: "open", checks: "pass" } } }), // ready
    makeStatus({ derived: { alive: false, pr: { number: 1, state: "merged", checks: "pass" } } }), // merged
    makeStatus({ derived: { alive: false, pr: { number: 1, state: "closed", checks: "none" } } }), // unknown
  ];
  expect(laneStateCounts(oneOfEach, now)).toEqual({
    conflict: 1,
    failed: 1,
    stalled: 1,
    running: 1,
    vanished: 1,
    blocked: 1,
    ready: 1,
    merged: 1,
    unknown: 1,
  });
  // Every state is a key — a known zero, not a missing one — and the keys are
  // exactly LANE_STATES, so the rollup can never be shown a state it cannot name.
  expect(Object.keys(laneStateCounts(oneOfEach, now)).sort()).toEqual(
    [...LANE_STATES].sort(),
  );
});

it("laneStateCounts tallies repeats and sums to the lanes given", () => {
  const running = makeStatus({ derived: { alive: true } });
  const merged = makeStatus({
    derived: { alive: false, pr: { number: 2, state: "merged", checks: "none" } },
  });
  const counts = laneStateCounts([running, running, running, merged], now);
  expect(counts.running).toBe(3);
  expect(counts.merged).toBe(1);
  expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(4);
});

it("laneStateCounts of no lanes is every state at zero — a known nothing, not a blank", () => {
  const empty = laneStateCounts([], now);
  expect(Object.values(empty)).toEqual(LANE_STATES.map(() => 0));
});

// The *hide inactive* set: what a human is wanted for. The page mirrors this list
// and a test holds them to the same fixture; here it is the rule stated once.
it("isNeedsHumanState names exactly the states a human is wanted for", () => {
  for (const state of NEEDS_HUMAN_STATES) {
    expect(isNeedsHumanState(state)).toBe(true);
  }
  for (const state of LANE_STATES) {
    const wants = NEEDS_HUMAN_STATES.includes(state);
    expect(isNeedsHumanState(state)).toBe(wants);
  }
});

