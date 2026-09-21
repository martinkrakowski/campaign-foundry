/**
 * Motion kinds for the motion wave. Declared here so the planner and compositor
 * share one list; each kind's rest pose `t` is the still-frame sample.
 */
export const MOTION_KINDS = [
  "ken-burns-in",
  "ken-burns-out",
  "headline-rise",
  "accent-wipe",
] as const;
export type MotionKind = (typeof MOTION_KINDS)[number];
export const MOTION_FPS = 30;

/**
 * How many frames the encoder writes for a clip of `durationSec` (TL4).
 *
 * **The encoder's rounding, stated once.** `CanvasFfmpegVideoCompositor` had
 * it inline at two call sites, and the web app had no way to ask: it cannot
 * import `CreativeGeneration` at all — that package is server-side Skia and is
 * not one of `apps/web`'s dependencies — so a caption "showing the encoded
 * duration" there could only have RECOMPUTED the formula, which is the twin
 * TL4 exists to refuse. A duplicated `Math.round` drifts silently: the caption
 * would keep claiming a length the encoder stopped producing.
 *
 * So it lives in the leaf both sides already read. The encoder calls it; the
 * tape calls it; neither states the arithmetic.
 */
export function encodedFrameCount(durationSec: number, fps: number): number {
  return Math.round(durationSec * fps);
}

/**
 * The clip length the encoder actually produces (TL4).
 *
 * Frames are whole, so a brief asking for 6.02 s at 30 fps gets 181 frames and
 * a clip of 6.0333… s. The caption shows this beside the brief's number so an
 * operator can see the difference rather than be surprised by it — which is
 * the whole of TL4, and the reason it is display-only.
 */
export function encodedDurationSec(durationSec: number, fps: number): number {
  return encodedFrameCount(durationSec, fps) / fps;
}

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
