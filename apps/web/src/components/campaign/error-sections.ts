
/** Maps user-facing field labels to their error keys. */
const LABEL_TO_KEY: Record<string, string> = {
  "Brief ID": "briefId",
  "Target Region": "targetRegion",
  "Target Audience": "targetAudience",
  "Campaign Message": "campaignMessage",
  "Product ID": "product-0-id",
  "Name": "product-0-name",
  "Colour": "product-0-color",
  "Logo Path": "product-0-logo",
  "Treatment ID": "treatment-0-id",
  "Layout": "treatment-0-layout",
  "Tone": "treatment-0-tone",
  "Count": "count",
  "Seed": "seed",
  "Min Distance": "minDistance",
  "Coverage per Product": "perProduct",
  "Coverage per Ratio": "perRatio",
  "Aspect Ratio": "ratio",
  "Background": "background",
  "Palette Shift": "paletteShift",
  "Formats": "formats",
  "Platforms": "platforms",
  "Motion Kind": "motion",
  "Duration": "duration",
};

/**
 * Derive error key from a field label.
 * For product/treatment fields, the caller must replace the index.
 */
export function keyForLabel(label: string): string | undefined {
  return LABEL_TO_KEY[label];
}

/** All valid error key patterns (validated by coverage test). */
export const KNOWN_KEY_PATTERNS: RegExp[] = [
  /^briefId$/,
  /^targetRegion$/,
  /^targetAudience$/,
  /^campaignMessage$/,
  /^products$/,
  /^product-\d+-id$/,
  /^product-\d+-name$/,
  /^product-\d+-color$/,
  /^product-\d+-logo$/,
  /^treatment-\d+-id$/,
  /^treatment-\d+-layout$/,
  /^treatment-\d+-tone$/,
  /^count$/,
  /^seed$/,
  /^minDistance$/,
  /^perProduct$/,
  /^perRatio$/,
  /^ratio$/,
  /^layout$/,
  /^tone$/,
  /^background$/,
  /^paletteShift$/,
  /^formats$/,
  /^platforms$/,
  /^motion$/,
  /^duration$/,
];

/** Check if a key matches any known pattern. */
export function isKnownKey(key: string): boolean {
  return KNOWN_KEY_PATTERNS.some((pattern) => pattern.test(key));
}
