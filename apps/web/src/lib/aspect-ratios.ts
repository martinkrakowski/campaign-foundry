/**
 * The aspect ratios the pipeline renders, in display order. Mirrors the domain's
 * AspectRatio set (1:1, 9:16, 16:9). Single source for the UI so counts/ordering
 * don't drift if the set changes.
 */
export const ASPECT_RATIOS = ["1:1", "9:16", "16:9"] as const;
