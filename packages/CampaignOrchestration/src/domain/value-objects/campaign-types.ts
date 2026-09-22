import type { AdvertisingUnit } from "./advertising-units.js";
import type { CanonicalTemplateId } from "./creative-templates.js";
import type { CreativeType } from "./creative-types.js";

/**
 * The campaign type's fixed vocabulary and the preset each type seeds a new
 * brief with (D108–D112, D120). Pure data with no external dependencies, so
 * the web client can pull it through the package root like `./aspect-ratios`.
 * The domain package must not import from Distribution (`yarn lint:arch`
 * enforces the layer direction), so platform ids stay plain strings here — the
 * same looseness as `output.platforms` on CampaignBrief — and the Distribution
 * test asserts every preset id resolves against `PLATFORM_PROFILES`. A type is a
 * preset, applied once at create and never re-applied (D109): the brief records
 * it so surfaces can read it, not so anything can enforce it.
 *
 * Per D120, each preset is re-parented over { unit, creativeType, template,
 * platforms, formats, mode }.
 */
export const CAMPAIGN_TYPES = ["social-post", "paid-social", "short-video", "display-ad"] as const;

export type CampaignType = (typeof CAMPAIGN_TYPES)[number];

/** Absent `type` on a brief means this (D112), so existing briefs never name it. */
export const DEFAULT_CAMPAIGN_TYPE: CampaignType = "social-post";

export interface CampaignTypePreset {
  readonly unit: AdvertisingUnit;
  readonly creativeType: CreativeType;
  readonly template: CanonicalTemplateId;
  readonly platforms: readonly string[];
  readonly formats: readonly ("static" | "motion" | "html")[];
  readonly mode: "brief" | "variation";
}

export const CAMPAIGN_TYPE_PRESETS: Readonly<Record<CampaignType, CampaignTypePreset>> = {
  // Stills only — a feed post has no motion surface. Classic mode: a social post is one creative per product × ratio.
  "social-post": {
    unit: "standard-web",
    creativeType: "image-text",
    template: "canonical-image-text",
    platforms: ["instagram-feed", "linkedin", "x"],
    formats: ["static"],
    mode: "brief",
  },
  // Every surface, both formats, Randomized — paid placements run the same feeds and want variants to test (D111).
  "paid-social": {
    unit: "standard-web",
    creativeType: "image-text",
    template: "canonical-image-text",
    platforms: [
      "instagram-feed",
      "linkedin",
      "x",
      "instagram-story",
      "instagram-reel",
      "tiktok",
      "youtube-short",
    ],
    formats: ["static", "motion"],
    mode: "variation",
  },
  // Motion only — every short-video platform is a 9:16 motion profile, and the API refuses motion under classic mode (D110), so the mode must be variation or the type mints campaigns that never run.
  "short-video": {
    unit: "standard-web",
    creativeType: "video",
    template: "canonical-video",
    platforms: ["instagram-story", "instagram-reel", "tiktok", "youtube-short"],
    formats: ["motion"],
    mode: "variation",
  },
  // HTML5 is the product (D161). The two `-html` profiles are what a new
  // display-ad generates. google-display, display-web, and
  // meta-audience-network are not generation platforms: image-html cannot
  // request a static format, and those profiles package the raster fallback
  // at package time instead.
  "display-ad": {
    unit: "standard-web",
    creativeType: "image-html",
    template: "canonical-image-html",
    platforms: ["google-display-html", "display-web-html"],
    formats: ["html"],
    mode: "brief",
  },
};

/**
 * One phrase per type, interpolated into every generator prompt (F5 / T4).
 * Prompt text, not UI copy — the adapters share this table so the sentence
 * cannot drift. Absent `type` uses the default, so prompts change once.
 */
export const CAMPAIGN_TYPE_PROMPT_HINTS: Readonly<Record<CampaignType, string>> = {
  "social-post": "a social post for organic feeds",
  "paid-social": "paid social advertising across feeds, stories and reels",
  "short-video": "short-form video for social feeds",
  "display-ad": "HTML5 display advertising in IAB banner sizes, with a static raster fallback",
};

/** The sentence every generator appends. Always present; absent or unknown type → social-post. */
export function campaignTypePromptSentence(type?: CampaignType): string {
  const resolved = (CAMPAIGN_TYPES as readonly string[]).includes(type as string)
    ? (type as CampaignType)
    : DEFAULT_CAMPAIGN_TYPE;
  return `Campaign type: ${CAMPAIGN_TYPE_PROMPT_HINTS[resolved]}.`;
}
