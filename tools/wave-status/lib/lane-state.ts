export type LaneState =
  | "conflict"
  | "failed"
  | "stalled"
  | "running"
  | "vanished"
  | "blocked"
  | "ready"
  | "merged"
  // The ranking's own gap, named: a PR state with no verdict — a closed PR,
  // which the collector can legitimately hand back. A question, never a guess.
  | "unknown";

// The states in the order a reader is shown them — the rollup's own ranking,
// highest-consequence first. Named once here so the per-wave and page-level
// counts, and the `laneStateCounts` zero-initialisation, cannot each invent
// their own list of what a state is: the derivation's output type is the only
// source of its vocabulary.
export const LANE_STATES: readonly LaneState[] = [
  "conflict",
  "failed",
  "stalled",
  "running",
  "vanished",
  "blocked",
  "ready",
  "merged",
  "unknown",
];

// The states that mean "a human is wanted": working now, gone quiet while
// working, contradicting itself, or failed. This is what *hide inactive* keeps —
// everything else (merged, ready, blocked, vanished, unknown) is a lane that is
// not moving and not stuck on a person. The page's inline copy of the rollup
// filter names the same set; a test holds them to the same truth against the
// state fixture, exactly as the parity test does for the derivation itself.
export const NEEDS_HUMAN_STATES: readonly LaneState[] = [
  "conflict",
  "failed",
  "stalled",
  "running",
];

export function isNeedsHumanState(state: LaneState): boolean {
  return NEEDS_HUMAN_STATES.includes(state);
}

export type LaneStateCounts = Record<LaneState, number>;

// Decision: lanes go quiet during a build.
export const stallThresholdMs = 15 * 60 * 1000;

import { LaneStatus } from "./types.js";

export function laneState(status: LaneStatus, nowMs: number): LaneState {
  const { derived } = status;
  if (status.disagreements.length > 0) {
    return "conflict";
  }
  if (
    (derived.exit !== undefined && derived.exit !== 0) ||
    (derived.gate?.exit !== undefined && derived.gate.exit !== 0) ||
    derived.pr?.checks === "fail"
  ) {
    return "failed";
  }
  if (derived.alive && derived.log !== undefined && derived.log.mtimeMs < nowMs - stallThresholdMs) {
    return "stalled";
  }
  if (derived.alive) {
    return "running";
  }
  if (derived.pr === undefined) {
    return "vanished";
  }
  if (derived.pr.state === "open" && (derived.pr.checks === "pending" || derived.pr.checks === "none")) {
    return "blocked";
  }
  if (derived.pr.state === "open" && derived.pr.checks === "pass") {
    return "ready";
  }
  if (derived.pr.state === "merged") {
    return "merged";
  }
  // The only PR state left is `closed`: the lane's PR was shut without merging,
  // which is not a verdict this ranking owns. Name the gap rather than guess at
  // it — and rather than throw, which is where this function and its copy in
  // the page first parted ways: the page could only render a word, so a throw
  // here was the divergence, not an exemption from it.
  return "unknown";
}

// The rollup, from the same derivation as the rows: bucket a set of lanes by
// the state `laneState` names for each, over `LANE_STATES` so every state
// carries a number (a known zero, not an absent key). The per-wave header and
// the page summary are both `laneStateCounts` over their lanes, and the page
// renders both from its inline `laneStateOf` — one computation each side, the
// same one the row cells use, so a count can never disagree with the rows
// beneath it. This is the module's half of that seam; the parity test in
// page.test.ts drives the fixture through both.
export function laneStateCounts(
  lanes: readonly LaneStatus[],
  nowMs: number,
): LaneStateCounts {
  const counts = {} as LaneStateCounts;
  for (const state of LANE_STATES) counts[state] = 0;
  for (const lane of lanes) counts[laneState(lane, nowMs)] += 1;
  return counts;
}
