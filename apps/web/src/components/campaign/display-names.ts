// The leaf subpath, never the package barrel: the barrel re-exports the
// infrastructure adapters, which pull node:fs/path/crypto into the browser bundle.
import { RATIO_VALUES } from "@campaignfoundry/CampaignOrchestration/aspect-ratios";
import { ANCHOR_VALUES } from "@campaignfoundry/CampaignOrchestration/variation-defaults";
import { PLATFORM_PROFILES } from "@campaignfoundry/Distribution/platform-profiles";

/** Display name for a format key. */
export function formatDisplayName(format: string): string {
  switch (format) {
    case "static": return "Still images";
    case "motion": return "Video";
    default: return format;
  }
}

/**
 * Display name for a ratio key ("1:1" → "Square"). `RATIO_VALUES` is a list of
 * ratio strings, so the label lives here — keyed by the domain's own values so a
 * new ratio is a compile error rather than a silent passthrough.
 */
const RATIO_LABELS: Record<(typeof RATIO_VALUES)[number], string> = {
  "1:1": "Square",
  "9:16": "Tall",
  "16:9": "Wide",
};

export function ratioDisplayName(ratio: string): string {
  return RATIO_LABELS[ratio as (typeof RATIO_VALUES)[number]] ?? ratio;
}

/**
 * Display name for an anchor value ("top" → "Top"). Keyed by the domain's own
 * values, so a new anchor is a compile error rather than a silent passthrough —
 * the messages jargon gate forbids raw ids on the cards (T4).
 */
const ANCHOR_LABELS: Record<(typeof ANCHOR_VALUES)[number], string> = {
  top: "Top",
  middle: "Middle",
  bottom: "Bottom",
};

export function anchorDisplayName(anchor: string): string {
  return ANCHOR_LABELS[anchor as (typeof ANCHOR_VALUES)[number]] ?? anchor;
}

/** Display name for a platform id (from PlatformProfile.label). */
export function platformDisplayName(id: string): string {
  // `?? id` after a cast never fires: the cast dereferences undefined first and
  // throws. An id we do not know passes through unchanged instead.
  return PLATFORM_PROFILES[id]?.label ?? id;
}
