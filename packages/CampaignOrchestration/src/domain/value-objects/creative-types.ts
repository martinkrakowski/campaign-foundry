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

/**
 * An ordering relation between two layer kinds (D128).
 *
 * "directly-above" is a stronger claim than "above": while "above" requires only
 * that the subject layer sits anywhere above the target in z-order
 * (`index(kind) > index(target)`), "directly-above" requires immediate adjacency
 * (`index(kind) === index(target) + 1`) with no intervening layers.
 */
export type OrderRelation = "above" | "directly-above";

/**
 * An ordering constraint between layer kinds (D128).
 *
 * Names a `kind` and the `target` kind it must sit above according to `relation`.
 *
 * Why this minimal 3-field shape expresses both "logo above image" and "shade directly above image":
 * "directly above" is a stronger claim than "above". By encoding the adjacency requirement
 * directly in the relation discriminant ("above" vs "directly-above"),
 * this single shape expresses both general z-order constraints (e.g. logo above image) and
 * strict physical contact constraints (e.g. shade directly above image) without boolean flags,
 * optional modifier fields, or nested condition trees. It is readable by both boundaries
 * (the API validator and the editor's offer derivation) without interpretation.
 */
export interface OrderConstraint {
  readonly kind: LayerKind;
  readonly relation: OrderRelation;
  readonly target: LayerKind;
}

export interface CreativeTypeRule {
  readonly unit: AdvertisingUnit;
  readonly accepts: readonly LayerKind[];   // every kind this type may hold
  readonly required: readonly LayerKind[];  // a subset of accepts; cannot be removed or disabled
  /**
   * How many layers of a kind the type may hold (D124): the compositor draws at
   * most one of each decorated kind. A kind missing from the map — or the field
   * absent — is unbounded.
   */
  readonly maxOf?: Partial<Record<LayerKind, number>>;
  /**
   * Budgets spanning several kinds (D124): the members TOGETHER may not exceed
   * `max`. `maxOf` cannot say "these two kinds share a budget of one" — per-kind
   * caps of 1 would admit `static-text` + `animated-text` (1 + 1) where the
   * compositor draws one headline block — so the shared form is its own field
   * rather than a pretence. Declared data, read by the same boundary as `maxOf`.
   */
  readonly sharedBudgets?: readonly {
    readonly kinds: readonly LayerKind[];
    readonly max: number;
  }[];
  /**
   * Ordering rules on kinds (D128): array position is z-order, bottom first.
   * Optional on the rule, absent meaning unconstrained.
   */
  readonly orderConstraints?: readonly OrderConstraint[];
  readonly outputFamilies: readonly ["static" | "motion" | "html", ...("static" | "motion" | "html")[]];
}

export const CREATIVE_TYPE_RULES: Readonly<Record<CreativeType, CreativeTypeRule>> = {
  "image-text": {
    unit: "standard-web",
    accepts: ["image", "shade", "accent", "static-text", "animated-text", "logo"],
    required: ["image", "static-text"],
    maxOf: { logo: 1, shade: 1, accent: 1 },
    sharedBudgets: [{ kinds: ["static-text", "animated-text"], max: 1 }],
    orderConstraints: [
      { kind: "logo", relation: "above", target: "image" },
      { kind: "shade", relation: "directly-above", target: "image" },
    ],
    outputFamilies: ["static", "motion"],
  },
  "image-html": {
    unit: "standard-web",
    accepts: ["image", "html", "logo"],
    required: ["image", "html"],
    maxOf: { logo: 1 },
    outputFamilies: ["html"],
  },
  "video": {
    unit: "standard-web",
    accepts: ["video", "shade", "animated-text", "logo"],
    required: ["video"],
    maxOf: { logo: 1, shade: 1 },
    outputFamilies: ["motion"],
  },
};
