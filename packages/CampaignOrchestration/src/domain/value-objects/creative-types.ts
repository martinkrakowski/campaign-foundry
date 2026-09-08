/**
 * Creative types vocabulary and compatibility rules table (D119, D124).
 *
 * A creative type owns what a creative is made of: an ordered, validated
 * layer list with a declared compatibility rule (§2.1). Compatibility is
 * a declared table, validated at the boundary (D124).
 *
 * Per §2.1, output families per creative type (most-default first):
 * - `image-text`: "static, or motion when a layer animates"
 * - `image-html`: "html" (+ raster fallback per D122)
 * - `video`: "motion"
 *
 * Per D131, `fill` appears in no `accepts` list until L11 draws it.
 */
import type { AdvertisingUnit } from "./advertising-units.js";
import type { LayerKind } from "./layer-kinds.js";

export const CREATIVE_TYPES = ["image-text", "image-html", "video"] as const;

export type CreativeType = (typeof CREATIVE_TYPES)[number];

export interface CreativeTypeRule {
  readonly unit: AdvertisingUnit;
  readonly accepts: readonly LayerKind[];   // every kind this type may hold
  readonly required: readonly LayerKind[];  // a subset of accepts; cannot be removed or disabled
  readonly outputFamilies: readonly ["static" | "motion" | "html", ...("static" | "motion" | "html")[]];
}

export const CREATIVE_TYPE_RULES: Readonly<Record<CreativeType, CreativeTypeRule>> = {
  "image-text": {
    unit: "standard-web",
    accepts: ["image", "shade", "accent", "static-text", "animated-text", "logo"],
    required: ["image", "static-text"],
    outputFamilies: ["static", "motion"],
  },
  "image-html": {
    unit: "standard-web",
    accepts: ["image", "html", "logo"],
    required: ["image", "html"],
    outputFamilies: ["html"],
  },
  "video": {
    unit: "standard-web",
    accepts: ["video", "shade", "animated-text", "logo"],
    required: ["video"],
    outputFamilies: ["motion"],
  },
};
