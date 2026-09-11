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
import type { ComplianceResult } from "./ComplianceResult.vo.js";
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
  readonly accepts: readonly LayerKind[]; // every kind this type may hold
  readonly required: readonly LayerKind[]; // a subset of accepts; cannot be removed or disabled
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
  readonly outputFamilies: readonly [
    "static" | "motion" | "html",
    ...("static" | "motion" | "html")[],
  ];
}

export const CREATIVE_TYPE_RULES: Readonly<
  Record<CreativeType, CreativeTypeRule>
> = {
  "image-text": {
    unit: "standard-web",
    accepts: [
      "image",
      "shade",
      "accent",
      "static-text",
      "animated-text",
      "logo",
    ],
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
  video: {
    unit: "standard-web",
    accepts: ["video", "shade", "animated-text", "logo"],
    required: ["video", "animated-text"],
    maxOf: { logo: 1, shade: 1 },
    sharedBudgets: [{ kinds: ["animated-text"], max: 1 }],
    outputFamilies: ["motion"],
  },
};

/**
 * Occlusion classification and behavior classes (D135).
 *
 * - `opaque`: full-bleed opacity; anything below is completely hidden.
 * - `attenuating`: contrast tint or scrim; text below is muted, not lost.
 * - `local`: bounded graphic; overlaps only where it sits.
 * - `none`: transparent or background layer; creates no occlusion over other layers.
 */
export type OcclusionBehavior = "opaque" | "attenuating" | "local" | "none";

export interface OcclusionRule {
  readonly behavior: OcclusionBehavior;
  /**
   * Which layer kinds this layer obscures when sitting above them.
   * "all" means any layer below it is obscured.
   * A list of kinds restricts occlusion to those specific kinds.
   * Absent/undefined for behavior "none".
   */
  readonly obscures?: "all" | readonly LayerKind[];
}

/**
 * Occlusion table (D135) — declared data beside CREATIVE_TYPE_RULES,
 * readable without interpretation so the editor and compositor cannot drift (D121).
 *
 * Verbatim rules from D135:
 * - `image` and `fill` are opaque — anything below them is hidden;
 * - `shade` and `accent` are attenuating — text below them is muted, not lost;
 * - `logo` is local — it overlaps only where it sits.
 *
 * Classification of kinds not classified by D135:
 * - `static-text`: behavior "none" — glyph letterforms are surrounded by transparent counters/interstices,
 *   so text does not obscure the canvas or imagery beneath it.
 * - `animated-text`: behavior "none" — animated glyphs similarly composite with transparent background,
 *   leaving layers below visible.
 * - `html`: behavior "none" — HTML layers manage their own styled bounds and transparency,
 *   acting as layout elements rather than full-frame occluders.
 * - `video`: behavior "none" — video serves as the base motion background plate in video creative types,
 *   never as an overlay or scrim over other layers.
 */
export const OCCLUSION_TABLE: Readonly<Record<LayerKind, OcclusionRule>> = {
  image: { behavior: "opaque", obscures: "all" },
  fill: { behavior: "opaque", obscures: "all" },
  shade: {
    behavior: "attenuating",
    obscures: ["static-text", "animated-text"],
  },
  accent: {
    behavior: "attenuating",
    obscures: ["static-text", "animated-text"],
  },
  logo: {
    behavior: "local",
    obscures: ["static-text", "animated-text"],
  },
  "static-text": { behavior: "none" },
  "animated-text": { behavior: "none" },
  html: { behavior: "none" },
  video: { behavior: "none" },
};

/**
 * Formats a specific pair occlusion reason (D135).
 * Names both layers and the effect:
 * - opaque: "will hide it"
 * - attenuating: "will mute it"
 * - local: "will overlap where it sits"
 *
 * Text layers are referred to as "the headline" per D135 verbatim:
 * "the shade layer now sits above the headline and will mute it".
 */
export function formatOcclusionReason(
  above: LayerKind,
  below: LayerKind,
  behavior: OcclusionBehavior,
): string {
  const aboveName =
    above === "static-text" || above === "animated-text"
      ? "headline"
      : above === "html"
        ? "HTML"
        : above;
  const belowName =
    below === "static-text" || below === "animated-text"
      ? "the headline"
      : below === "html"
        ? "the HTML"
        : `the ${below}`;
  const verb =
    behavior === "opaque"
      ? "hide it"
      : behavior === "attenuating"
        ? "mute it"
        : "overlap where it sits";
  return `the ${aboveName} layer now sits above ${belowName} and will ${verb}`;
}

/**
 * Checks whether layer `above` sitting above layer `below` produces an occlusion (D135, D136).
 *
 * Advisory representation in ComplianceResult (D136):
 * Returns `{ passed: true, reason?: string }`.
 * An advisory finding never fails a compliance gate (`passed: true`), but conveys
 * the finding through `reason`. Adding a separate severity field to ComplianceResult
 * would alter the contract of existing checks (validateLegalCopy, validateBrandColorDensity).
 * Returning `passed: true` with `reason` preserves type compatibility across all gates.
 */
export function checkPairOcclusion(
  above: LayerKind,
  below: LayerKind,
): ComplianceResult {
  const rule = OCCLUSION_TABLE[above];
  if (!rule || rule.behavior === "none" || !rule.obscures) {
    return { passed: true };
  }
  const isObscured =
    rule.obscures === "all" ||
    (Array.isArray(rule.obscures) && rule.obscures.includes(below));
  if (!isObscured) {
    return { passed: true };
  }
  return {
    passed: true,
    reason: formatOcclusionReason(above, below, rule.behavior),
  };
}

export interface OcclusionFinding {
  readonly above: LayerKind;
  readonly below: LayerKind;
  readonly behavior: OcclusionBehavior;
}

/**
 * Scans for any occluding layer pair present in `after` that was absent from `before` (D135, D136).
 *
 * Move, add and remove all use the same question: only a newly created occlusion
 * is reported, so pre-existing occlusions are never announced as changes.
 * Returns the first newly created advisory occlusion finding encountered (top-down),
 * or null if none was created.
 */
export function findOcclusionDelta(
  before: readonly { readonly id?: string; readonly kind: LayerKind }[],
  after: readonly { readonly id?: string; readonly kind: LayerKind }[],
): OcclusionFinding | null {
  const refMap = new Map<object, string>();
  const tag = (
    layers: readonly { readonly id?: string; readonly kind: LayerKind }[],
    prefix: string,
  ) =>
    layers.map((layer, index) => {
      let id: string;
      if (typeof layer.id === "string" && layer.id.length > 0) {
        id = layer.id;
      } else {
        const existing = refMap.get(layer);
        if (existing) {
          id = existing;
        } else {
          id = `${prefix}_${index}`;
          refMap.set(layer, id);
        }
      }
      return { id, kind: layer.kind };
    });

  const taggedBefore = tag(before, "b");
  const taggedAfter = tag(after, "a");

  const beforePairs = new Set<string>();
  for (let j = 0; j < taggedBefore.length; j++) {
    const above = taggedBefore[j]!;
    for (let i = 0; i < j; i++) {
      const below = taggedBefore[i]!;
      if (checkPairOcclusion(above.kind, below.kind).reason !== undefined) {
        beforePairs.add(`${above.id}->${below.id}`);
      }
    }
  }

  for (let j = taggedAfter.length - 1; j >= 1; j--) {
    const above = taggedAfter[j]!;
    for (let i = j - 1; i >= 0; i--) {
      const below = taggedAfter[i]!;
      const key = `${above.id}->${below.id}`;
      if (!beforePairs.has(key)) {
        if (checkPairOcclusion(above.kind, below.kind).reason !== undefined) {
          return {
            above: above.kind,
            below: below.kind,
            behavior: OCCLUSION_TABLE[above.kind]!.behavior,
          };
        }
      }
    }
  }

  return null;
}

/**
 * Checks whether repositioning a layer at `to` creates an occlusion (D135).
 *
 * Evaluated per layer on every reposition:
 * - When `from` is specified: delegates to findOcclusionDelta over before and after stacks (D135).
 *   If to === from, before equals after and delta yields no finding naturally.
 * - When `from` is undefined: caller cannot say what moved (no before-stack),
 *   so reports the current state rather than a delta.
 */
export function checkRepositionOcclusion(
  layers: readonly { readonly kind: LayerKind }[],
  to: number,
  from?: number,
): ComplianceResult {
  if (to < 0 || to >= layers.length || layers.length === 0) {
    return { passed: true };
  }
  if (from !== undefined && (from < 0 || from >= layers.length)) {
    return { passed: true };
  }

  // When from is undefined, the caller cannot say what moved, so there is no before-stack;
  // report the current state rather than a delta.
  if (from === undefined) {
    const subject = layers[to]!;
    for (let j = to + 1; j < layers.length; j++) {
      const above = layers[j]!;
      const result = checkPairOcclusion(above.kind, subject.kind);
      if (result.reason !== undefined) {
        return result;
      }
    }
    for (let i = to - 1; i >= 0; i--) {
      const below = layers[i]!;
      const result = checkPairOcclusion(subject.kind, below.kind);
      if (result.reason !== undefined) {
        return result;
      }
    }
    return { passed: true };
  }

  // Reconstruct the before-stack by undoing the splice (D135).
  // Tag layers by their index in the after-stack to identify distinct layer instances.
  const taggedAfter = layers.map((layer, index) => ({
    id: `_layer_${index}`,
    kind: layer.kind,
  }));
  const taggedBefore = [...taggedAfter];
  const [moved] = taggedBefore.splice(to, 1);
  taggedBefore.splice(from, 0, moved!);

  const finding = findOcclusionDelta(taggedBefore, taggedAfter);
  if (finding) {
    return {
      passed: true,
      reason: formatOcclusionReason(
        finding.above,
        finding.below,
        finding.behavior,
      ),
    };
  }

  return { passed: true };
}
