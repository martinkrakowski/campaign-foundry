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
  throw new Error("laneState: not implemented");
}
