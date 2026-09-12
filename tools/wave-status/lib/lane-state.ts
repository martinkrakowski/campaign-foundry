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
