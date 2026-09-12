import { stringify } from "yaml";

/**
 * The canonical brief YAML writer, shared by the API (which persists it) and the
 * web editor tests (which assert round-trip determinism against it). Exactly one
 * implementation exists — a fork of this under `apps/web` was deleted (R4.3) —
 * and it is pinned to the `yaml` package's default schema (YAML 1.2), the same
 * schema the loader parses with. A writer and a parser on different schemas is
 * the real hazard: `dumpBrief` emits what `parse` reads back unchanged.
 */

/** The brief's canonical top-level key order (the sample-campaign order), then any remaining keys. */
export const BRIEF_KEY_ORDER = [
  "schemaVersion",
  "template",
  "id",
  "targetRegion",
  "targetAudience",
  "campaignMessage",
  "localizedMessage",
  "products",
  "treatments",
  "mode",
  "type",
  "variation",
  "output",
] as const;

/** A template layer's canonical key order (L3b, D134, D129, HL1): identity, kind, enabled, then its props and elements. */
const LAYER_KEY_ORDER = ["id", "kind", "enabled", "props", "elements"] as const;

/** One html element's canonical key order (HL1): kind, its copy, then its frame. */
const ELEMENT_KEY_ORDER = ["kind", "text", "frame"] as const;

/** A frame's canonical key order (D130): the fractions, then the anchor. */
const FRAME_KEY_ORDER = ["x", "y", "w", "h", "anchor"] as const;

/**
 * The props' canonical key order: the order the domain's `LayerProps` union
 * declares its members (D134) — shade's `alpha`, accent's heights, logo's
 * widths, then the text layers' `anchor` and `typeFloor`. A valid props object
 * carries one kind's keys only, so one flat list orders them all; keys the
 * union does not name keep their written order at the end.
 */
const PROPS_KEY_ORDER = ["alpha", "solidHeight", "fadeHeight", "width", "margin", "anchor", "typeFloor"] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Re-emit `source` with `order`'s keys first (present, in order), then any remaining keys. */
function orderedKeys(source: Record<string, unknown>, order: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of order) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  for (const key of Object.keys(source)) {
    // Ownership, never `key in out`: an own key named `constructor`, `toString`
    // or `valueOf` is also an inherited member of `out`, and `in` would drop it.
    if (!Object.prototype.hasOwnProperty.call(out, key) && source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

/** Reorder one html element's keys (kind, text, frame) and, when it carries a frame, the frame's keys. */
function orderedElement(element: unknown): unknown {
  if (!isPlainRecord(element)) return element;
  const ordered = orderedKeys(element, ELEMENT_KEY_ORDER);
  if (isPlainRecord(ordered.frame)) {
    ordered.frame = orderedKeys(ordered.frame, FRAME_KEY_ORDER);
  }
  return ordered;
}

/**
 * Reorder a layer's keys (id, kind, enabled, props, elements) and, when it
 * carries props or elements, those keys in their own canonical order.
 */
function orderedLayer(layer: unknown): unknown {
  if (!isPlainRecord(layer)) return layer;
  const ordered = orderedKeys(layer, LAYER_KEY_ORDER);
  if (isPlainRecord(ordered.props)) {
    ordered.props = orderedKeys(ordered.props, PROPS_KEY_ORDER);
  }
  if (Array.isArray(ordered.elements)) {
    ordered.elements = ordered.elements.map(orderedElement);
  }
  return ordered;
}

/** Reorder a template's layers; a template that is not an object with a layers array passes through. */
function orderedTemplate(template: unknown): unknown {
  if (!isPlainRecord(template) || !Array.isArray(template.layers)) return template;
  return { ...template, layers: template.layers.map(orderedLayer) };
}

/**
 * Serialize a brief with the canonical key order, then any remaining keys.
 *
 * `lineWidth: 0` disables folding so long messages stay on one line,
 * `aliasDuplicateObjects: false` is the `yaml`-package equivalent of js-yaml's
 * `noRefs`: a brief never grows anchors just because two fields reference the
 * same object, and `flowCollectionPadding: false` keeps flow collections in the
 * unpadded form js-yaml wrote (`[static, motion]`, not `[ static, motion ]`).
 * Keys whose value is `undefined` are omitted, matching the previous js-yaml
 * dump byte for byte on the briefs this project writes. A template's layers
 * dump with the layer's own canonical order — `id`, `kind`, `enabled`,
 * `props` and `elements`, with the props keys in the union's order (L3b,
 * D134) and each element's keys and frame keys in order (HL1) — so a save
 * serialises a hand-written layer deterministically too.
 */
export function dumpBrief(brief: object): string {
  const source = brief as Record<string, unknown>;
  const ordered = orderedKeys(source, BRIEF_KEY_ORDER);
  const template = orderedTemplate(ordered.template);
  if (template !== undefined) ordered.template = template;
  return stringify(ordered, {
    lineWidth: 0,
    aliasDuplicateObjects: false,
    flowCollectionPadding: false,
  });
}
