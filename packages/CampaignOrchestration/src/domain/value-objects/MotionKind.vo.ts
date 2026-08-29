/**
 * Motion kinds for the motion wave. Declared here so the planner and compositor
 * share one list; each kind's rest pose `t` is the still-frame sample.
 */
export const MOTION_KINDS = ["ken-burns-in", "ken-burns-out", "headline-rise", "accent-wipe"] as const;
export type MotionKind = (typeof MOTION_KINDS)[number];
export const MOTION_FPS = 30;

const REST_T: Record<MotionKind, number> = {
  "ken-burns-in": 1,
  "ken-burns-out": 0,
  "headline-rise": 1,
  "accent-wipe": 1,
};

/** Rest-pose `t` in [0, 1] — stills render this sample. */
export function restT(kind: MotionKind): number {
  return REST_T[kind];
}
