/**
 * Advertising units fixed vocabulary (D119).
 *
 * An advertising unit owns where a creative runs: its placements, canvases
 * (sizes or ratio), safe insets, and packaging rules (§2.1).
 *
 * One member today ("standard-web") is correct: it is the placement family
 * the display advertising work already built (§1 F7).
 */
export const ADVERTISING_UNITS = ["standard-web"] as const;

export type AdvertisingUnit = (typeof ADVERTISING_UNITS)[number];

/** Default advertising unit for standard display and social placements. */
export const DEFAULT_ADVERTISING_UNIT: AdvertisingUnit = "standard-web";
