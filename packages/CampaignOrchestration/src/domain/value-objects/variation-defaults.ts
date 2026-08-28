import { MOTION_KINDS, type MotionKind } from "./MotionKind.vo.js";

/**
 * The variation axes' vocabulary and defaults, in the one place both the planner and
 * the editor can read them.
 *
 * `VariationPolicy.vo.ts` is the natural home, but it hashes its policy with
 * `node:crypto` and so can never be bundled for a browser. Keeping these here — a leaf
 * with no runtime dependency beyond the motion kinds — lets the web app read the domain
 * rather than keep a copy of it that silently drifts (D18). The VO re-exports every name
 * below, so its own public surface is unchanged.
 */

/**
 * Background *axis* values from the brief parser (`procedural` | `asset-pool` | `genai`).
 * Distinct from the rendered-asset BackgroundSource (firefly/imagen/…).
 */
export const BACKGROUND_AXIS_SOURCES = ["procedural", "asset-pool", "genai"] as const;
export type BackgroundAxisSource = (typeof BACKGROUND_AXIS_SOURCES)[number];

/** The only supported pool reference for the `headline` axis. */
export const HEADLINE_POOL_REF = "pool://copy";

export const DEFAULT_BACKGROUND_SOURCES: readonly BackgroundAxisSource[] = ["procedural"];
export const DEFAULT_PALETTE_SHIFT: readonly number[] = [0];
/**
 * Motion axis default when `output.formats` requests "motion" but the brief
 * lists no `axes.motion`: every kind. A brief that asks for clips gets clips;
 * a static brief (no motion format) draws no motion kinds at all.
 */
export const DEFAULT_MOTION: readonly MotionKind[] = MOTION_KINDS;
/** Clip length in whole seconds; the parser bounds it to [2, 30]. */
export const DEFAULT_DURATION: readonly number[] = [6];
export const MIN_DURATION_SEC = 2;
export const MAX_DURATION_SEC = 30;
