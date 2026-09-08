import { DISPLAY_SIZES, type DisplaySize } from "./display-sizes.js";

/**
 * The ratio axis' fixed vocabulary and each ratio's canvas dimensions. The
 * web client can pull this leaf through the package's `./aspect-ratios`
 * subpath the way it pulls `./motion-kinds` — the VO that wraps it cannot
 * cross that line (its Result idiom imports @campaignfoundry/shared, whose
 * root reaches node:fs).
 *
 * `resolveCanvas` is the join point with the display family (D113): the one
 * function that turns a `CanvasSpec` into pixels. `RATIO_VALUES` and
 * `RATIO_DIMENSIONS` stay the social family.
 */
export const RATIO_VALUES = ["1:1", "9:16", "16:9"] as const;

export type AspectRatioValue = (typeof RATIO_VALUES)[number];

/** Canvas pixel dimensions per ratio (DeterministicLayerStacking contract). */
export const RATIO_DIMENSIONS: Record<AspectRatioValue, { readonly width: number; readonly height: number }> = {
  "1:1": { width: 1080, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "16:9": { width: 1920, height: 1080 },
};

/** A canvas is either a social ratio or an IAB display size — never both, never a third family. */
export type CanvasSpec =
  | { readonly ratio: AspectRatioValue; readonly size?: never }
  | { readonly size: DisplaySize; readonly ratio?: never };

/**
 * The only function that turns a spec into pixels. Social ratios stay
 * 1080/1920; display sizes are exact, never scaled (D113).
 */
export function resolveCanvas(spec: CanvasSpec): { readonly width: number; readonly height: number } {
  if ("ratio" in spec && "size" in spec) {
    throw new Error("CanvasSpec must carry exactly one of ratio/size");
  }
  // Exclusive `never` keeps both keys on the type, so `in` cannot narrow; the
  // runtime check above already refused a both-keys spec.
  const exclusive = spec as { readonly ratio: AspectRatioValue } | { readonly size: DisplaySize };
  if ("ratio" in exclusive) return RATIO_DIMENSIONS[exclusive.ratio];
  return DISPLAY_SIZES[exclusive.size];
}
