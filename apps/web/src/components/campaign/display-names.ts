// The leaf subpath, never the package barrel: the barrel re-exports the
// infrastructure adapters, which pull node:fs/path/crypto into the browser bundle.
import { RATIO_VALUES } from "@campaignfoundry/CampaignOrchestration/aspect-ratios";
import { ANCHOR_VALUES } from "@campaignfoundry/CampaignOrchestration/variation-defaults";
import { ALIGN_VALUES, FONT_WEIGHT_VALUES, type TextEffectKind } from "@campaignfoundry/CampaignOrchestration/creative-style";
import { PLATFORM_PROFILES } from "@campaignfoundry/Distribution/platform-profiles";

import type { CampaignMode } from "./editor-state";

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

/**
 * Display labels for the style weights and alignments (T7) — keyed by the
 * domain's own vocabularies, so a new member is a compile error rather than a
 * raw value on screen (D18).
 */
const WEIGHT_LABELS: Record<(typeof FONT_WEIGHT_VALUES)[number], string> = {
  400: "Regular",
  700: "Bold",
};

export function weightDisplayName(weight: number): string {
  return WEIGHT_LABELS[weight as (typeof FONT_WEIGHT_VALUES)[number]] ?? String(weight);
}

const ALIGN_LABELS: Record<(typeof ALIGN_VALUES)[number], string> = {
  left: "Left",
  center: "Center",
  right: "Right",
};

export function alignDisplayName(align: string): string {
  return ALIGN_LABELS[align as (typeof ALIGN_VALUES)[number]] ?? align;
}

/**
 * Display labels for the style text effects (T6) — the MOTION_KIND_META
 * pattern, as its own map: keyed by the domain's own vocabulary, so a new kind
 * is a compile error rather than a raw kind id on screen (D18/D50). The still
 * shows each effect's rest pose, so the name in words is what tells the user
 * the still moves.
 */
export const TEXT_EFFECT_META: Record<TextEffectKind, string> = {
  "fade-in": "Fade in",
  "rise-in": "Rise in",
  "slide-in": "Slide in",
  "scale-in": "Scale in",
};

export function textEffectDisplayName(effect: string): string {
  return TEXT_EFFECT_META[effect as TextEffectKind] ?? effect;
}

/** Display name for a platform id (from PlatformProfile.label). */
export function platformDisplayName(id: string): string {
  // `?? id` after a cast never fires: the cast dereferences undefined first and
  // throws. An id we do not know passes through unchanged instead.
  return PLATFORM_PROFILES[id]?.label ?? id;
}

/**
 * Display labels for the campaign modes (D4) — keyed by the mode union itself,
 * so a new mode is a compile error rather than a raw value on screen (D18).
 * The two words every mode surface reads: the cards' captions, the products
 * error and the create dialog's inherited-mode readout.
 */
const MODE_LABELS: Record<CampaignMode, string> = {
  brief: "Classic",
  variation: "Randomized",
};

export function modeDisplayName(mode: CampaignMode): string {
  return MODE_LABELS[mode];
}
