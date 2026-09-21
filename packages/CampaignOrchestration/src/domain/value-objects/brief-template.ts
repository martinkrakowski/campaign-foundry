/**
 * Pinned creative template reference and materialized layer list carried by the brief (D120, D123, D128, D134).
 *
 * A campaign renders with no library present because the brief carries the pinned reference
 * and the materialized layer list (D123). Array position is z-order; there is no order field (D128).
 * Each layer may carry its own `props` (D134): overrides of the geometry that layer already
 * reads — nothing invented — where every absent prop means the value the layer resolves today.
 */
import { ADVERTISING_UNITS, type AdvertisingUnit } from "./advertising-units.js";
import { RATIO_VALUES } from "./aspect-ratios.js";
import type { CampaignType } from "./campaign-types.js";
import { CAMPAIGN_TYPE_PRESETS } from "./campaign-types.js";
import type { LayerFrame } from "./creative-geometry.js";
import {
  CANONICAL_TEMPLATES,
  CANONICAL_TEMPLATE_IDS,
  type CanonicalTemplateId,
  type CreativeTemplateLayer,
} from "./creative-templates.js";
import { DISPLAY_SIZE_VALUES } from "./display-sizes.js";
import {
  CREATIVE_TYPES,
  CREATIVE_TYPE_RULES,
  type CreativeType,
  type OrderConstraint,
} from "./creative-types.js";
import { layerElementsProblem, type HtmlElement } from "./html-element.js";
import { LAYER_KINDS, type LayerKind } from "./layer-kinds.js";
import { layerTracksProblem, type Track } from "./tracks.js";
import { ANCHOR_VALUES, type AnchorKind } from "./variation-defaults.js";

export { clickDestinationProblem, type ClickDestinationProblem } from "./click-destination.js";

/**
 * The per-layer props (D134): overrides of the geometry each layer already
 * reads — nothing invented. Numbers are fractions of the canvas in the same
 * units `CREATIVE_GEOMETRY` uses, so a prop value is comparable to the
 * constant it overrides (0.05 solid, 0.16 logo width, 0.4 autofit floor).
 * Every prop is optional, and absent means the value the layer resolves
 * today — from `CREATIVE_GEOMETRY`, the treatment, or the style, exactly as
 * now. The union is keyed by kind at the validation boundary: `accent`
 * cannot carry `logo`'s props.
 *
 * `alt` is the one member that is not geometry (X2): the text alternative an
 * `image` layer carries, the one kind whose whole content is a picture a
 * reader may not be able to see. It is here and nowhere else because here is
 * where it can be *meant* — a shade or an accent is decoration, a text layer's
 * copy is already text, and an `html` layer's alternative belongs to the image
 * elements inside it rather than to the container. An empty string is not
 * absence: it declares the image decorative, which is a different claim from
 * saying nothing about it.
 *
 * `video`, `html` and `fill` carry no props at all — theirs arrive with the
 * lanes that draw them. `shade` carries none either (R-D4, withdrawn
 * 2026-09-15): the tone axis is never absent — it defaults to every tone —
 * so an `alpha` override would always silence it.
 */

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

/**
 * `image`'s props (X2): the text alternative the layer's picture carries.
 * Absent means no alternative is declared; the empty string declares the image
 * decorative, which a reader must be told rather than left to infer.
 */
export interface ImageProps {
  readonly alt?: string;
}

export type LayerProps = AccentProps | LogoProps | TextProps | ImageProps;

/**
 * The props vocabulary per layer kind (D134), in `LayerProps`' declaration
 * order. A kind not listed here — every member of `LAYER_KINDS` is listed —
 * and an unknown kind carry no props.
 */
const LAYER_PROPS: Readonly<Record<LayerKind, readonly string[]>> = {
  shade: [],
  accent: ["solidHeight", "fadeHeight"],
  logo: ["width", "margin"],
  "static-text": ["anchor", "typeFloor"],
  "animated-text": ["anchor", "typeFloor"],
  image: ["alt"],
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
export function layerEnabledProblem(enabled: unknown): LayerEnabledProblem | undefined {
  if (enabled === undefined || typeof enabled === "boolean") return undefined;
  return { field: "enabled", must: "be a boolean", value: enabled };
}

/** Why a layer's `frame` is not a shape the brief may carry (D130); undefined when it is. */
export interface LayerFrameProblem {
  /** The frame subpath the problem names — "" for the frame itself, `.x` for one value. */
  readonly path: string;
  /** The requirement, phrased to follow "must" in a `Campaign brief field …` message. */
  readonly must: string;
  /** The offending value, for the message's `got <JSON>` clause. */
  readonly value: unknown;
}

/** A base frame's fields (D130), in declaration order. */
const LAYER_FRAME_FIELDS = ["x", "y", "w", "h", "anchor", "byFamily"] as const;

/** A `byFamily` overlay's fields: the two canvas families, nothing else. */
const BY_FAMILY_FIELDS = ["ratio", "size"] as const;

/** A per-canvas overlay may restate any of the box/anchor fields, never `byFamily`. */
const LAYER_FRAME_OVERRIDE_FIELDS = ["x", "y", "w", "h", "anchor"] as const;

/**
 * The one frame decision both boundaries read (D130): `isLayerEntry` refuses
 * on a defined problem, and the API's `validateTemplate` formats the same
 * problem into its message shape — the two cannot drift. Absent frame is
 * always fine: absence is the kind's default rect. A present frame is an
 * object of [0, 1] fractions, a vocabulary `anchor`, and an optional
 * `byFamily` whose keys are real ratios and sizes; unknown extra junk is
 * refused, not ignored.
 */
export function layerFrameProblem(frame: unknown): LayerFrameProblem | undefined {
  if (frame === undefined) return undefined;
  if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
    return { path: "", must: "be an object", value: frame };
  }
  const record = frame as Record<string, unknown>;
  for (const [field, value] of Object.entries(record)) {
    if (!(LAYER_FRAME_FIELDS as readonly string[]).includes(field)) {
      return {
        path: `.${field}`,
        must: `be one of ${LAYER_FRAME_FIELDS.map((key) => `"${key}"`).join(", ")}`,
        value,
      };
    }
  }
  const boxProblem = frameBoxProblem(record, "");
  if (boxProblem !== undefined) return boxProblem;
  if (record.byFamily !== undefined) {
    return byFamilyProblem(record.byFamily);
  }
  return undefined;
}

/** Required x/y/w/h in [0, 1] and a vocabulary anchor — the base frame's box. */
function frameBoxProblem(
  record: Record<string, unknown>,
  path: string,
): LayerFrameProblem | undefined {
  for (const field of ["x", "y", "w", "h"] as const) {
    const value = record[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      return { path: `${path}.${field}`, must: "be a number in [0, 1]", value };
    }
  }
  const anchor = record.anchor;
  if (typeof anchor !== "string" || !(ANCHOR_VALUES as readonly string[]).includes(anchor)) {
    return {
      path: `${path}.anchor`,
      must: `be one of ${ANCHOR_VALUES.map((value) => `"${value}"`).join(", ")}`,
      value: anchor,
    };
  }
  return undefined;
}

function byFamilyProblem(byFamily: unknown): LayerFrameProblem | undefined {
  if (typeof byFamily !== "object" || byFamily === null || Array.isArray(byFamily)) {
    return { path: ".byFamily", must: "be an object", value: byFamily };
  }
  const record = byFamily as Record<string, unknown>;
  for (const [field, value] of Object.entries(record)) {
    if (!(BY_FAMILY_FIELDS as readonly string[]).includes(field)) {
      return {
        path: `.byFamily.${field}`,
        must: `be one of ${BY_FAMILY_FIELDS.map((key) => `"${key}"`).join(", ")}`,
        value,
      };
    }
  }
  if (record.ratio !== undefined) {
    const problem = familyMapProblem(
      record.ratio,
      ".byFamily.ratio",
      RATIO_VALUES as readonly string[],
    );
    if (problem !== undefined) return problem;
  }
  if (record.size !== undefined) {
    const problem = familyMapProblem(
      record.size,
      ".byFamily.size",
      DISPLAY_SIZE_VALUES as readonly string[],
    );
    if (problem !== undefined) return problem;
  }
  return undefined;
}

function familyMapProblem(
  map: unknown,
  path: string,
  allowed: readonly string[],
): LayerFrameProblem | undefined {
  if (typeof map !== "object" || map === null || Array.isArray(map)) {
    return { path, must: "be an object", value: map };
  }
  const record = map as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    const entryPath = `${path}[${JSON.stringify(key)}]`;
    if (!allowed.includes(key)) {
      return {
        path: entryPath,
        must: `be one of ${allowed.map((name) => `"${name}"`).join(", ")}`,
        value,
      };
    }
    const overrideProblem = frameOverrideProblem(value, entryPath);
    if (overrideProblem !== undefined) return overrideProblem;
  }
  return undefined;
}

function frameOverrideProblem(override: unknown, path: string): LayerFrameProblem | undefined {
  if (typeof override !== "object" || override === null || Array.isArray(override)) {
    return { path, must: "be an object", value: override };
  }
  const record = override as Record<string, unknown>;
  for (const [field, value] of Object.entries(record)) {
    if (!(LAYER_FRAME_OVERRIDE_FIELDS as readonly string[]).includes(field)) {
      return {
        path: `${path}.${field}`,
        must: `be one of ${LAYER_FRAME_OVERRIDE_FIELDS.map((key) => `"${key}"`).join(", ")}`,
        value,
      };
    }
  }
  for (const field of ["x", "y", "w", "h"] as const) {
    if (record[field] === undefined) continue;
    const value = record[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      return { path: `${path}.${field}`, must: "be a number in [0, 1]", value };
    }
  }
  if (record.anchor !== undefined) {
    const anchor = record.anchor;
    if (typeof anchor !== "string" || !(ANCHOR_VALUES as readonly string[]).includes(anchor)) {
      return {
        path: `${path}.anchor`,
        must: `be one of ${ANCHOR_VALUES.map((value) => `"${value}"`).join(", ")}`,
        value: anchor,
      };
    }
  }
  return undefined;
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
 * included — before any entries are walked. `alt` is the one prop that is not
 * a fraction: it is a string, and the empty string is admitted, because it
 * declares a decorative image rather than naming no alternative at all.
 */
export function layerPropsProblem(kind: LayerKind, props: unknown): LayerPropsProblem | undefined {
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
  for (const [field, value] of Object.entries(props as Record<string, unknown>)) {
    if (!allowed.includes(field)) {
      return {
        path: `.${field}`,
        must: `be one of ${allowed.map((key) => `"${key}"`).join(", ")} for layer kind "${kind}"`,
        value,
      };
    }
    if (field === "anchor") {
      if (typeof value !== "string" || !(ANCHOR_VALUES as readonly string[]).includes(value)) {
        return {
          path: `.${field}`,
          must: `be one of ${ANCHOR_VALUES.map((anchor) => `"${anchor}"`).join(", ")}`,
          value,
        };
      }
      continue;
    }
    if (field === "alt") {
      if (typeof value !== "string") {
        return { path: `.${field}`, must: "be a string", value };
      }
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      return { path: `.${field}`, must: "be a number in [0, 1]", value };
    }
  }
  return undefined;
}

/**
 * Whether any text layer (`static-text` / `animated-text`) in `layers` carries
 * an `anchor` prop (R-D4) — the domain half of the boundary refusal for a
 * brief that pins a layer's anchor while a variation axis also decides it.
 * `BriefTemplate` carries no axis of its own, so axis presence is each
 * boundary's own read (the API's raw `variation.axes.anchor`, the editor's
 * `anchorAxisActive`); the two facts are combined by the caller, never here —
 * the same split `layerPropsProblem` keeps between the domain decision and
 * the boundary's message shape.
 */
export function templateHasAnchorProp(layers: readonly CreativeTemplateLayer[]): boolean {
  return layers.some(
    (layer) =>
      (layer.kind === "static-text" || layer.kind === "animated-text") &&
      (layer.props as TextProps | undefined)?.anchor !== undefined,
  );
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
 * The one shape contract a persisted brief's template must satisfy (L3a, L3b, L8m, X11).
 *
 * A type predicate, not a validator: `unknown` becomes a `BriefTemplate` only
 * through this check, and anything else is not one. `id` is a canonical member
 * and matches the canonical template of its `creativeType`, `version` a
 * positive integer, `creativeType` and `unit` vocabulary members, and `layers`
 * a non-empty array. It is the single guard used at both storage boundaries
 * — the editor's draft restore and the run context's `cf:brief` restore — so a
 * half-written template can never be cast through and reach `toBrief`. Array
 * position IS z-order (D128): a template whose layer order violates the creative
 * type's declared `above`/`below` constraints is not a valid template. A layer's `enabled`,
 * when present, must be a boolean (D129) — absent means enabled. A layer's `frame`,
 * when present, must be a canvas-relative box of [0, 1] fractions, a vocabulary
 * `anchor`, and an optional `byFamily` whose keys are real ratios and sizes
 * (D130) — unknown extra junk is refused. A layer's `props`,
 * when present, must be a shape that layer's kind may carry (D134, X2) — same key set,
 * every number a fraction in [0, 1], the anchor a vocabulary member, `alt` a string — so an
 * unknown key or a value out of range cannot ride the guard into the editor or
 * the run. An `html` layer's `elements`, when present, must be well-formed
 * elements of the vocabulary (HL1), so the two renderers never receive a list
 * the other cannot draw. A layer's `tracks`, when present, must be well-formed
 * keyframe tracks (K1), and only a kind this compositor draws through one
 * single mechanism may carry them. Every `layers` entry must itself be a layer — a non-null, non-array
 * object naming a non-empty string `id` and a vocabulary `kind` (L5): a `null`, a bare
 * string or a kindless object is not a layer, and admitting one crashes the
 * first consumer that dereferences `layer.kind`. And ids are unique within the
 * list, the rule the API's `validateTemplate` already applies.
 *
 * Beyond the per-entry shape, the guard mirrors every table rule the API's
 * `validateTemplate` applies to the layer list, read from the same
 * `CREATIVE_TYPE_RULES` (X11): a kind must be one the creative type `accepts`
 * (D124); each kind must not exceed its `maxOf` cap and each `sharedBudgets`
 * group must not exceed its `max`, counted by presence — a disabled layer
 * still holds its slot (D124, MP-D5); and every kind in `required` must have
 * at least one ENABLED instance, absent `enabled` counting as enabled (D129,
 * MP-D4) — a draft whose only required layer is switched off, or whose
 * required layer was deleted, is refused here exactly as the API refuses it,
 * so it can never reach the compositor and render incomplete. With every rule
 * mirrored, the two boundaries cannot disagree about a draft's shape; a
 * restored draft that fails here falls back to the canonical template.
 */
export function isBriefTemplate(value: unknown): value is BriefTemplate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (
    !(
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
      raw.layers.length > 0 &&
      raw.layers.every(isLayerEntry) &&
      new Set(raw.layers.map((layer) => (layer as LayerEntry).id)).size === raw.layers.length
    )
  ) {
    return false;
  }
  const creativeType = raw.creativeType as CreativeType;
  if (CANONICAL_TEMPLATES[creativeType].id !== raw.id) return false;
  const layers = raw.layers as readonly LayerEntry[];
  if (!satisfiesTypeRules(creativeType, layers)) return false;
  return satisfiesOrderConstraints(creativeType, layers);
}

/**
 * The table half of the guard (X11): the rules `validateTemplate` reads from
 * `CREATIVE_TYPE_RULES` and nowhere else — `accepts`, `maxOf`, `sharedBudgets`
 * and `required` — so this boundary and the API consult the same declared data
 * and cannot drift on a template's shape. Budgets count every layer of a kind
 * present, disabled included (MP-D5); "required" counts only ENABLED
 * instances, absent meaning enabled (D129, MP-D4).
 */
function satisfiesTypeRules(creativeType: CreativeType, layers: readonly LayerEntry[]): boolean {
  const rules = CREATIVE_TYPE_RULES[creativeType];
  const counts = new Map<string, number>();
  const enabledKinds = new Set<string>();
  for (const layer of layers) {
    if (!(rules.accepts as readonly string[]).includes(layer.kind)) {
      return false;
    }
    counts.set(layer.kind, (counts.get(layer.kind) ?? 0) + 1);
    if (layer.enabled !== false) {
      enabledKinds.add(layer.kind);
    }
  }
  for (const kind of rules.accepts) {
    const max = rules.maxOf[kind];
    if (max === undefined) continue;
    if ((counts.get(kind) ?? 0) > max) return false;
  }
  for (const budget of rules.sharedBudgets) {
    const used = budget.kinds.reduce((sum, kind) => sum + (counts.get(kind) ?? 0), 0);
    if (used > budget.max) return false;
  }
  return rules.required.every((kind) => enabledKinds.has(kind));
}

/** The one layer shape every consumer below the guard dereferences. */
interface LayerEntry {
  readonly id: string;
  readonly kind: LayerKind;
  readonly enabled?: boolean;
  readonly frame?: LayerFrame;
  readonly props?: LayerProps;
  readonly elements?: readonly HtmlElement[];
  readonly tracks?: readonly Track[];
}

/**
 * A `layers` entry is a layer (L5): a non-null, non-array object naming a
 * non-empty string `id` (the API's `validateTemplate` refuses an empty one)
 * and a vocabulary `kind` — the fields every consumer below the
 * guard dereferences, and which a `null`, a bare string or a kindless object
 * names neither of — with `enabled`, when present, a boolean (D129), `frame`,
 * when present, a canvas-relative box (D130), `props`, when present, a shape
 * that kind may carry (D134), `elements`,
 * when present, an `html` layer's element list (HL1), and `tracks`, when
 * present, that kind's own keyframe tracks (K1) — so an element with an
 * unknown kind, a non-vocabulary anchor, a fraction outside [0, 1], or a
 * track on a kind that draws through no single mechanism cannot ride the
 * guard into the editor. This is the
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
    rec.id.length === 0 ||
    typeof rec.kind !== "string" ||
    !(LAYER_KINDS as readonly string[]).includes(rec.kind)
  ) {
    return false;
  }
  if (layerEnabledProblem(rec.enabled) !== undefined) return false;
  if (layerFrameProblem(rec.frame) !== undefined) return false;
  if (
    rec.props !== undefined &&
    layerPropsProblem(rec.kind as LayerKind, rec.props) !== undefined
  ) {
    return false;
  }
  if (layerElementsProblem(rec.kind as LayerKind, rec.elements) !== undefined) {
    return false;
  }
  return layerTracksProblem(rec.kind as LayerKind, rec.tracks) === undefined;
}
