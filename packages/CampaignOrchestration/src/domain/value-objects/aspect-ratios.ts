/**
 * The ratio axis' fixed vocabulary and each ratio's canvas dimensions. Pure
 * data with no imports, so the web client can pull it through the package's
 * `./aspect-ratios` subpath the way it pulls `./motion-kinds` — the VO that
 * wraps it cannot cross that line (its Result idiom imports
 * @campaignfoundry/shared, whose root reaches node:fs).
 */
export const RATIO_VALUES = ["1:1", "9:16", "16:9"] as const;

export type AspectRatioValue = (typeof RATIO_VALUES)[number];

/** Canvas pixel dimensions per ratio (DeterministicLayerStacking contract). */
export const RATIO_DIMENSIONS: Record<AspectRatioValue, { readonly width: number; readonly height: number }> = {
  "1:1": { width: 1080, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "16:9": { width: 1920, height: 1080 },
};
