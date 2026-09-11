/**
 * Pinned creative template reference and materialized layer list carried by the brief (D120, D123, D128, D134).
 *
 * A campaign renders with no library present because the brief carries the pinned reference
 * and the materialized layer list (D123). Array position is z-order; there is no order field (D128).
 * Each layer may carry its own `props` (D134): overrides of the geometry that layer already
 * reads — nothing invented — where every absent prop means the value the layer resolves today.
 */
import {
  ADVERTISING_UNITS,
  type AdvertisingUnit,
} from "./advertising-units.js";
import type { CampaignType } from "./campaign-types.js";
import { CAMPAIGN_TYPE_PRESETS } from "./campaign-types.js";
import {
  CANONICAL_TEMPLATES,
  CANONICAL_TEMPLATE_IDS,
  type CanonicalTemplateId,
  type CreativeTemplateLayer,
} from "./creative-templates.js";
import {
  CREATIVE_TYPES,
  CREATIVE_TYPE_RULES,
  type CreativeType,
  type OrderConstraint,
} from "./creative-types.js";
import { LAYER_KINDS, type LayerKind } from "./layer-kinds.js";
import { ANCHOR_VALUES, type AnchorKind } from "./variation-defaults.js";

/**
 * The per-layer props (D134): overrides of the geometry each layer already
 * reads — nothing invented. Numbers are fractions of the canvas in the same
 * units `CREATIVE_GEOMETRY` uses, so a prop value is comparable to the
 * constant it overrides (0.05 solid, 0.16 logo width, 0.7/0.4 shade alpha).
 * Every prop is optional, and absent means the value the layer resolves
 * today — from `CREATIVE_GEOMETRY`, the treatment, or the style, exactly as
 * now. The union is keyed by kind at the validation boundary: `shade` cannot
 * carry `logo`'s props, and the kinds L3 does not draw — `image`, `video`,
 * `html`, `fill` — carry no props at all (theirs arrive with the lanes that
 * draw them).
 */

/** `shade`'s props: the contrast shade alpha, the `shadeAlpha` pair (0.7 bold / 0.4 subtle). */
export interface ShadeProps {
  readonly alpha?: number;
}

/** `accent`'s props: solid band and fade heights, × canvas height (0.05 / 0.06). */
export interface AccentProps {
  readonly solidHeight?: number;
  readonly fadeHeight?: number;
}

/** `logo`'s props: block width and edge margin, × canvas width (0.16 / 0.04). */
export interface LogoProps {
  readonly width?: number;
  readonly margin?: number;
}

/** The text layers' props: the headline block's anchor (T4's vocabulary) and autofit floor (0.4). */
export interface TextProps {
  readonly anchor?: AnchorKind;
  readonly typeFloor?: number;
}

export type LayerProps = ShadeProps | AccentProps | LogoProps | TextProps;

/**
 * The props vocabulary per layer kind (D134), in `LayerProps`' declaration
 * order. A kind not listed here — every member of `LAYER_KINDS` is listed —
 * and an unknown kind carry no props.
 */
const LAYER_PROPS: Readonly<Record<LayerKind, readonly string[]>> = {
  shade: ["alpha"],
  accent: ["solidHeight", "fadeHeight"],
  logo: ["width", "margin"],
  "static-text": ["anchor", "typeFloor"],
  "animated-text": ["anchor", "typeFloor"],
  image: [],
  video: [],
  html: [],
  fill: [],
};

/** Why a layer's `enabled` is not a shape the brief may carry (D129); undefined when it is. */
export interface LayerEnabledProblem {
  /** The field name the problem names — always "enabled". */
  readonly field: "enabled";
  /** The requirement, phrased to follow "must" in a `Campaign brief field …` message. */
  readonly must: string;
  /** The offending value, for the message's `got <JSON>` clause. */
  readonly value: unknown;
}

/**
 * The one enabled decision both boundaries read (D129): `isBriefTemplate`
 * refuses on a defined problem, and the API's `validateTemplate` formats the
 * same problem into its message shape — the two cannot drift, the way
 * `layerPropsProblem` is shared. Absent enabled is always fine: absence means
 * enabled (true). Defined enabled must be a boolean.
 */
export function layerEnabledProblem(
  enabled: unknown,
): LayerEnabledProblem | undefined {
  if (enabled === undefined || typeof enabled === "boolean") return undefined;
  return { field: "enabled", must: "be a boolean", value: enabled };
}

/** Why a layer's `props` is not a shape the brief may carry (D134); undefined when it is. */
export interface LayerPropsProblem {
  /** The props subpath the problem names — "" for the props object itself, `.<field>` for one value. */
  readonly path: string;
  /** The requirement, phrased to follow "must" in a `Campaign brief field …` message. */
  readonly must: string;
  /** The offending value, for the message's `got <JSON>` clause. */
  readonly value: unknown;
}

/**
 * The one props decision both boundaries read (D134): `isBriefTemplate`
 * refuses on a defined problem, and the API's `validateTemplate` formats the
 * same problem into its message shape — the two cannot drift, the way
 * `styleProblem` is shared between the domain and the parser (T5). Absent
 * props are always fine: absence is the resolved-default behaviour. A kind
 * that carries no props refuses any defined `props` — the empty object
 * included — before any entries are walked.
 */
export function layerPropsProblem(
  kind: LayerKind,
  props: unknown,
): LayerPropsProblem | undefined {
  if (props === undefined) return undefined;
  if (!(LAYER_KINDS as readonly string[]).includes(kind)) {
    return {
      path: "",
      must: `be absent for layer kind "${kind}"`,
      value: props,
    };
  }
  if (typeof props !== "object" || props === null || Array.isArray(props)) {
    return { path: "", must: "be an object", value: props };
  }
  const allowed = LAYER_PROPS[kind];
  if (allowed.length === 0) {
    return {
      path: "",
      must: `be absent for layer kind "${kind}"`,
      value: props,
    };
  }
  for (const [field, value] of Object.entries(
    props as Record<string, unknown>,
  )) {
    if (!allowed.includes(field)) {
      return {
        path: `.${field}`,
        must: `be one of ${allowed.map((key) => `"${key}"`).join(", ")} for layer kind "${kind}"`,
        value,
      };
    }
    if (field === "anchor") {
      if (
        typeof value !== "string" ||
        !(ANCHOR_VALUES as readonly string[]).includes(value)
      ) {
        return {
          path: `.${field}`,
          must: `be one of ${ANCHOR_VALUES.map((anchor) => `"${anchor}"`).join(", ")}`,
          value,
        };
      }
      continue;
    }
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1
    ) {
      return { path: `.${field}`, must: "be a number in [0, 1]", value };
    }
  }
  return undefined;
}

export interface BriefTemplate {
  readonly id: CanonicalTemplateId; // the pinned reference
  readonly version: number; // pinned; a new version is a new record (D123)
  readonly creativeType: CreativeType;
  readonly unit: AdvertisingUnit;
  readonly layers: readonly CreativeTemplateLayer[]; // materialised; array position is z-order (D128)
}

/**
 * Materializes the default template for a given campaign type from the canonical library (D120, D123).
 */
export function templateFromCanonical(type: CampaignType): BriefTemplate {
  const preset = CAMPAIGN_TYPE_PRESETS[type];
  const canonical = CANONICAL_TEMPLATES[preset.creativeType];
  return {
    id: preset.template,
    version: canonical.version,
    creativeType: preset.creativeType,
    unit: preset.unit,
    layers: canonical.layers,
  };
}

/**
 * Evaluates whether a layer list satisfies the ordering constraints declared for
 * its creative type in `CREATIVE_TYPE_RULES` (D128).
 *
 * Array position is z-order, bottom first (D128):
 * - Index 0 is the bottom layer.
 * - Index length - 1 is the topmost layer.
 *
 * A constraint { kind, relation, target } applies when `kind` is present in the list
 * (if `kind` is absent, e.g. an optional layer that was removed, the constraint is satisfied).
 *
 * - "above": every layer of `kind` must sit at a higher index than every layer of `target`.
 * - "directly-above": every layer of `kind` at index k must have k > 0 and layers[k - 1].kind === target.
 */
export function satisfiesOrderConstraints(
  creativeType: CreativeType,
  layers: readonly { readonly kind: LayerKind }[],
  constraint?: OrderConstraint,
): boolean {
  const rules = CREATIVE_TYPE_RULES[creativeType];
  const constraints = constraint ? [constraint] : rules?.orderConstraints;
  if (!constraints || constraints.length === 0) return true;

  for (const c of constraints) {
    const kIndices: number[] = [];
    const tIndices: number[] = [];
    for (let i = 0; i < layers.length; i++) {
      if (layers[i].kind === c.kind) kIndices.push(i);
      if (layers[i].kind === c.target) tIndices.push(i);
    }

    // If either kind or target is not in the layer list, the constraint is unviolated.
    if (kIndices.length === 0 || tIndices.length === 0) continue;

    switch (c.relation) {
      case "above": {
        const minK = Math.min(...kIndices);
        const maxT = Math.max(...tIndices);
        if (minK <= maxT) return false;
        break;
      }
      case "directly-above": {
        for (const k of kIndices) {
          if (k === 0 || layers[k - 1].kind !== c.target) {
            return false;
          }
        }
        break;
      }
    }
  }

  return true;
}

/**
 * The one shape contract a persisted brief's template must satisfy (L3a, L3b, L8m).
 *
 * A type predicate, not a validator: `unknown` becomes a `BriefTemplate` only
 * through this check, and anything else is not one. `id` is a canonical member,
 * `version` a positive integer, `creativeType` and `unit` vocabulary members,
 * and `layers` an array. It is the single guard used at both storage boundaries
 * — the editor's draft restore and the run context's `cf:brief` restore — so a
 * half-written template can never be cast through and reach `toBrief`. Array
 * position IS z-order (D128): a template whose layer order violates the creative
 * type's declared `above`/`below` constraints is not a valid template. A layer's `enabled`,
 * when present, must be a boolean (D129) — absent means enabled. A layer's `props`,
 * when present, must be a shape that layer's kind may carry (D134) — same key set,
 * every number a fraction in [0, 1], the anchor a vocabulary member — so an
 * unknown key or a value out of range cannot ride the guard into the editor or
 * the run. Every `layers` entry must itself be a layer — a non-null, non-array
 * object naming a string `id` and a vocabulary `kind` (L5): a `null`, a bare
 * string or a kindless object is not a layer, and admitting one crashes the
 * first consumer that dereferences `layer.kind`. And ids are unique within the
 * list, the rule the API's `validateTemplate` already applies, so the two
 * boundaries cannot disagree about a draft's shape.
 */
export function isBriefTemplate(value: unknown): value is BriefTemplate {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.id === "string" &&
    (CANONICAL_TEMPLATE_IDS as readonly string[]).includes(raw.id) &&
    typeof raw.version === "number" &&
    Number.isInteger(raw.version) &&
    raw.version > 0 &&
    typeof raw.creativeType === "string" &&
    (CREATIVE_TYPES as readonly string[]).includes(raw.creativeType) &&
    typeof raw.unit === "string" &&
    (ADVERTISING_UNITS as readonly string[]).includes(raw.unit) &&
    Array.isArray(raw.layers) &&
    raw.layers.every(isLayerEntry) &&
    new Set(raw.layers.map((layer) => (layer as LayerEntry).id)).size ===
      raw.layers.length &&
    satisfiesOrderConstraints(
      raw.creativeType as CreativeType,
      raw.layers as readonly LayerEntry[],
    )
  );
}

/** The one layer shape every consumer below the guard dereferences. */
interface LayerEntry {
  readonly id: string;
  readonly kind: LayerKind;
  readonly enabled?: boolean;
  readonly props?: LayerProps;
}

/**
 * A `layers` entry is a layer (L5): a non-null, non-array object naming a
 * string `id` and a vocabulary `kind` — the fields every consumer below the
 * guard dereferences, and which a `null`, a bare string or a kindless object
 * names neither of — with `enabled`, when present, a boolean (D129), and
 * `props`, when present, a shape that kind may carry (D134). This is the
 * per-layer half of `isBriefTemplate`, the one check a stored draft's entries
 * face, so it carries the whole entry contract, not only the props half it
 * once was: a corrupt entry used to pass as "no props problem" and crash the
 * editor's first `layer.kind` dereference on mount, and a duplicated id used
 * to ride in where the API's `validateTemplate` refuses. Refusing here sends
 * the whole template to the canonical fallback.
 */
function isLayerEntry(layer: unknown): layer is LayerEntry {
  const rec =
    typeof layer === "object" && layer !== null && !Array.isArray(layer)
      ? (layer as Record<string, unknown>)
      : undefined;
  if (
    rec === undefined ||
    typeof rec.id !== "string" ||
    typeof rec.kind !== "string" ||
    !(LAYER_KINDS as readonly string[]).includes(rec.kind)
  ) {
    return false;
  }
  if (layerEnabledProblem(rec.enabled) !== undefined) return false;
  if (rec.props === undefined) return true;
  return layerPropsProblem(rec.kind as LayerKind, rec.props) === undefined;
}
