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

/** The social family: a spec that names a ratio, not a display size. */
function isRatioFamily(spec: CanvasSpec): spec is { readonly ratio: AspectRatioValue; readonly size?: never } {
  return spec.ratio !== undefined;
}

/**
 * Scale basis for type and logo width (D114).
 *
 * - **ratio family:** `w` — D55 width-proportional, so 1:1 / 9:16 / 16:9 stay
 *   byte-identical by construction.
 * - **size family:** the short side `min(w, h)`. Type size never takes the long
 *   side: a 728×90 headline is `90 × sizeScale`, not `728 × sizeScale`.
 *
 * Wrap width and logo margin are not this function — they are width-genuine
 * terms and go through {@link widthTermBasis}.
 */
export function scaleBasis(spec: CanvasSpec, w: number, h: number): number {
  if (isRatioFamily(spec)) return w;
  return Math.min(w, h);
}

/**
 * Wrap width and logo margin are width terms: they use `w` for both families
 * (D114). A 728×90 wraps across the leaderboard; a 160×600 wraps at 160 px,
 * not 600. Type size is not a width term — it stays on {@link scaleBasis}.
 */
export function widthTermBasis(_spec: CanvasSpec, w: number, _h: number): number {
  return w;
}

/**
 * The type-size readout in pixels: `sizeScale` times {@link scaleBasis} at
 * the spec's resolved canvas, rounded the same way the compositor rounds.
 * One helper, so the editor cannot re-derive a different number than A2.
 */
export function scaleBasisPx(spec: CanvasSpec, sizeScale: number): number {
  const { width, height } = resolveCanvas(spec);
  return Math.round(sizeScale * scaleBasis(spec, width, height));
}

/**
 * The social ratio whose canvas aspect is nearest the spec's — the vocabulary
 * the background port speaks (`ImageGeneratorPort` takes an `AspectRatio`, and
 * the social family is all it can name). A size-family preview resolves its
 * background at this orientation; the compositor then stretches it over the
 * exact display canvas, so a leaderboard asks for a wide background, not a
 * square one. A ratio-family spec is itself.
 */
export function nearestSocialRatio(spec: CanvasSpec): AspectRatioValue {
  if (spec.ratio !== undefined) return spec.ratio;
  const { width, height } = resolveCanvas(spec);
  const aspect = width / height;
  let nearest: AspectRatioValue = RATIO_VALUES[0];
  let nearestDiff = Number.POSITIVE_INFINITY;
  for (const ratio of RATIO_VALUES) {
    const { width: w, height: h } = RATIO_DIMENSIONS[ratio];
    const diff = Math.abs(aspect - w / h);
    if (diff < nearestDiff) {
      nearestDiff = diff;
      nearest = ratio;
    }
  }
  return nearest;
}
