import { laneState, stallThresholdMs } from "../lane-state";
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

it("vanished", () => {
  const s = makeStatus({});
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
