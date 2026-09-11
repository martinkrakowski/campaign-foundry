export type LaneState =
  | "conflict"
  | "failed"
  | "stalled"
  | "running"
  | "vanished"
  | "blocked"
  | "ready"
  | "merged";

// Decision: lanes go quiet during a build.
export const stallThresholdMs = 15 * 60 * 1000;

import { LaneStatus } from "./types.js";

export function laneState(status: LaneStatus, nowMs: number): LaneState {
  const { derived } = status;
  if (status.disagreements.length > 0) {
    return "conflict";
  }
  if (derived.exit !== undefined && derived.exit !== 0) {
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
  if (derived.pr.state === "open" && derived.pr.checks === "pending") {
    return "blocked";
  }
  if (derived.pr.state === "open" && derived.pr.checks === "pass") {
    return "ready";
  }
  return "merged";
}
