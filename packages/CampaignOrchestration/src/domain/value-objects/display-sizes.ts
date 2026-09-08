/**
 * The display family's fixed vocabulary and each unit's exact pixel size
 * (D113). A second ratio family, not more members of `RATIO_VALUES`: a display
 * unit is an exact pixel size that must not be scaled. Pure data with no
 * imports, so the web client can pull it through the package's
 * `./display-sizes` subpath the way it pulls `./aspect-ratios`.
 */
export const DISPLAY_SIZES = {
  "300x250": { width: 300, height: 250 }, // medium rectangle
  "728x90": { width: 728, height: 90 }, // leaderboard
  "160x600": { width: 160, height: 600 }, // wide skyscraper
  "320x50": { width: 320, height: 50 }, // mobile banner
  "300x600": { width: 300, height: 600 }, // half page
} as const;

export type DisplaySize = keyof typeof DISPLAY_SIZES;

/**
 * Table order — a tuple so the order is a compile-time fact, not
 * `Object.keys`' runtime iteration. Locked to `DISPLAY_SIZES` by a type-level
 * equality check and a deep-equals test; neither side is derived from the other.
 */
export const DISPLAY_SIZE_VALUES = ["300x250", "728x90", "160x600", "320x50", "300x600"] as const;
