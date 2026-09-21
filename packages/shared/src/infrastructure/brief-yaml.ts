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
  "clickDestination",
] as const;

/**
 * A template layer's canonical key order (L3b, D134, D129, D130, HL1, K1):
 * identity, kind, enabled, its frame, then its props, elements and — last,
 * deliberately — its keyframe tracks (K1): motion is a choreography layered
 * over an already-defined shape and content, so it sits after both.
 */
const LAYER_KEY_ORDER = ["id", "kind", "enabled", "frame", "props", "elements", "tracks"] as const;

/**
 * One html element's canonical key order (HL1, HL5e): kind, its copy, the
 * style override of that copy (what it says about the copy sits beside the
 * copy), then its frame.
 */
const ELEMENT_KEY_ORDER = ["kind", "text", "style", "frame"] as const;

/** An element style block's canonical key order (HL5e), matching the VO's. */
const ELEMENT_STYLE_KEY_ORDER = ["fontWeight", "fontFamily"] as const;

/** A frame's canonical key order (D130): the fractions, then the anchor, then per-family overlays. */
const FRAME_KEY_ORDER = ["x", "y", "w", "h", "anchor", "byFamily"] as const;

/** A `byFamily` map's canonical key order (D130): social ratios, then display sizes. */
const BY_FAMILY_KEY_ORDER = ["ratio", "size"] as const;

/** One keyframe track's canonical key order (K1): the property, then its stops. */
const TRACK_KEY_ORDER = ["property", "stops"] as const;

/** One track stop's canonical key order (K1, K-D8): position, value, its easing override, then its clock. */
const STOP_KEY_ORDER = ["t", "value", "easing", "clock"] as const;

/**
 * The props' canonical key order: the order the domain's `LayerProps` union
 * declares its members (D134) — accent's heights, logo's widths, the text
 * layers' `anchor` and `typeFloor`, then the image layer's `alt` (X2). `shade`
 * carries no props (R-D4, withdrawn 2026-09-15 — `alpha` is gone). A valid
 * props object carries one kind's keys only, so one flat list orders them
 * all; keys the union does not name keep their written order at the end.
 */
const PROPS_KEY_ORDER = [
  "solidHeight",
  "fadeHeight",
  "width",
  "margin",
  "anchor",
  "typeFloor",
  "alt",
] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Re-emit `source` with `order`'s keys first (present, in order), then any remaining keys. */
function orderedKeys(
  source: Record<string, unknown>,
  order: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of order) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  for (const key of Object.keys(source)) {
    // Ownership, never `key in out`: an own key named `constructor`, `toString`
    // or `valueOf` is also an inherited member of `out`, and `in` would drop it.
    if (!Object.prototype.hasOwnProperty.call(out, key) && source[key] !== undefined)
      out[key] = source[key];
  }
  return out;
}

/** Reorder one html element's keys (kind, text, style, frame) and, when it carries a frame or a style block, those keys in their own order. */
function orderedElement(element: unknown): unknown {
  if (!isPlainRecord(element)) return element;
  const ordered = orderedKeys(element, ELEMENT_KEY_ORDER);
  if (isPlainRecord(ordered.style)) {
    ordered.style = orderedKeys(ordered.style, ELEMENT_STYLE_KEY_ORDER);
  }
  if (isPlainRecord(ordered.frame)) {
    ordered.frame = orderedFrame(ordered.frame);
  }
  return ordered;
}

/** Reorder a frame's keys (x, y, w, h, anchor, byFamily) and any per-family overlays. */
function orderedFrame(frame: Record<string, unknown>): Record<string, unknown> {
  const ordered = orderedKeys(frame, FRAME_KEY_ORDER);
  if (isPlainRecord(ordered.byFamily)) {
    ordered.byFamily = orderedByFamily(ordered.byFamily);
  }
  return ordered;
}

function orderedByFamily(byFamily: Record<string, unknown>): Record<string, unknown> {
  const ordered = orderedKeys(byFamily, BY_FAMILY_KEY_ORDER);
  if (isPlainRecord(ordered.ratio)) {
    ordered.ratio = orderedFrameMap(ordered.ratio);
  }
  if (isPlainRecord(ordered.size)) {
    ordered.size = orderedFrameMap(ordered.size);
  }
  return ordered;
}

function orderedFrameMap(map: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(map)) {
    out[key] = isPlainRecord(value) ? orderedFrame(value) : value;
  }
  return out;
}

/** Reorder one keyframe track's keys (property, stops) and each stop's own keys. */
function orderedTrack(track: unknown): unknown {
  if (!isPlainRecord(track)) return track;
  const ordered = orderedKeys(track, TRACK_KEY_ORDER);
  if (Array.isArray(ordered.stops)) {
    ordered.stops = ordered.stops.map(orderedStop);
  }
  return ordered;
}

/** Reorder one track stop's keys (t, value, easing, clock). */
function orderedStop(stop: unknown): unknown {
  if (!isPlainRecord(stop)) return stop;
  return orderedKeys(stop, STOP_KEY_ORDER);
}

/**
 * Reorder a layer's keys (id, kind, enabled, frame, props, elements, tracks)
 * and, when it carries a frame, props, elements or tracks, those keys in
 * their own canonical order.
 */
function orderedLayer(layer: unknown): unknown {
  if (!isPlainRecord(layer)) return layer;
  const ordered = orderedKeys(layer, LAYER_KEY_ORDER);
  if (isPlainRecord(ordered.frame)) {
    ordered.frame = orderedFrame(ordered.frame);
  }
  if (isPlainRecord(ordered.props)) {
    ordered.props = orderedKeys(ordered.props, PROPS_KEY_ORDER);
  }
  if (Array.isArray(ordered.elements)) {
    ordered.elements = ordered.elements.map(orderedElement);
  }
  if (Array.isArray(ordered.tracks)) {
    ordered.tracks = ordered.tracks.map(orderedTrack);
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
 * `frame`, `props` and `elements`, with the frame keys in D130 order and the
 * props keys in the union's order (L3b, D134) and each element's keys, style
 * keys and frame keys in order (HL1, HL5e) — so a save
 * serialises a hand-written layer deterministically too. `tracks`, when
 * present, sits last (K1) with each track's own keys (`property`, `stops`)
 * and each stop's (`t`, `value`, `easing`, `clock`) in their own order.
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
