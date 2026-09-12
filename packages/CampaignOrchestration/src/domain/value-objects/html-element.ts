/**
 * The HTML layer's element vocabulary and its validation (HL1, HL-D1, HL-D2).
 *
 * An `html` layer holds *elements*, not layers (HL-D1). Each element is
 * `{ kind, text?, frame }`, constrained to the kinds both renderers can
 * express — `text`, `button`, `image` (HL-D2) — so the canvas compositor and
 * the markup assembler draw the same creative from one list. The kinds are the
 * whole vocabulary: `image` carries no copy, and a future per-element override
 * (`style`) or click destination arrives with the lane that reads it, never as
 * an unread field (the D134 lesson).
 *
 * `frame` reuses D130's shape: fractions of the resolved canvas plus the
 * vertical `anchor` vocabulary (`variation-defaults.ts`). D130's per-canvas
 * `byFamily` override map is deliberately absent — no renderer reads it yet,
 * and the layer frame lane owns it when it lands.
 *
 * `layerElementsProblem` is the one per-layer elements decision both boundaries
 * read, the way `layerPropsProblem` is the one per-layer props decision: the
 * editor's stored-draft guard (`isBriefTemplate`) and the API's
 * `validateTemplate` cannot disagree about what an element is, and only the
 * message shape is local to each.
 */
import type { LayerKind } from "./layer-kinds.js";
import { ANCHOR_VALUES, type AnchorKind } from "./variation-defaults.js";

/** The element kinds an `html` layer may carry (HL-D2), in declaration order. */
export const HTML_ELEMENT_KINDS = ["text", "button", "image"] as const;

export type HtmlElementKind = (typeof HTML_ELEMENT_KINDS)[number];

/**
 * A canvas-relative frame (D130), in fractions of the resolved canvas:
 * `x`/`y` are the box origin and `w`/`h` its size, all in [0, 1], and
 * `anchor` is the vertical placement vocabulary (`top` | `middle` | `bottom`).
 * Reused verbatim by an element's `frame`; the layer frame lane adopts it when
 * D130 lands.
 */
export interface Frame {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly anchor: AnchorKind;
}

/**
 * One element inside an `html` layer. `text` is the copy the `text` and
 * `button` kinds carry and the `image` kind must not; every element positions
 * itself with a `frame`.
 */
export interface HtmlElement {
  readonly kind: HtmlElementKind;
  readonly text?: string;
  readonly frame: Frame;
}

/** Why a layer's `elements` is not a shape the brief may carry (HL1); undefined when it is. */
export interface LayerElementsProblem {
  /** The elements subpath the problem names — `[i]` for an element, `[i].field` for one value. */
  readonly path: string;
  /** The requirement, phrased to follow "must" in a `Campaign brief field …` message. */
  readonly must: string;
  /** The offending value, for the message's `got <JSON>` clause. */
  readonly value: unknown;
}

/**
 * The keys each element kind may carry, in declaration order. The `image` kind
 * names no `text`, so the field table — not a second branch — refuses copy on
 * an image, exactly as `LAYER_PROPS` refuses another kind's props.
 */
const ELEMENT_FIELDS: Readonly<Record<HtmlElementKind, readonly string[]>> = {
  text: ["kind", "text", "frame"],
  button: ["kind", "text", "frame"],
  image: ["kind", "frame"],
};

/** A frame's fields (D130), in declaration order. */
const FRAME_FIELDS = ["x", "y", "w", "h", "anchor"] as const;

/**
 * The one elements decision both boundaries read (HL1), in the shape of
 * `layerPropsProblem` (D134). Absent `elements` is always fine — an `html`
 * layer with no elements is the canonical template's own state. Only the
 * `html` layer kind carries elements; any other kind refuses a defined
 * `elements` — the empty array included — before any entry is walked. A
 * present list must be an array of well-formed elements.
 */
export function layerElementsProblem(
  kind: LayerKind,
  elements: unknown,
): LayerElementsProblem | undefined {
  if (elements === undefined) return undefined;
  if (kind !== "html") {
    return {
      path: "",
      must: `be absent for layer kind "${kind}"`,
      value: elements,
    };
  }
  if (!Array.isArray(elements)) {
    return { path: "", must: "be an array of elements", value: elements };
  }
  for (let i = 0; i < elements.length; i += 1) {
    const problem = elementProblem(elements[i]);
    if (problem !== undefined) {
      return { path: `[${i}]${problem.path}`, must: problem.must, value: problem.value };
    }
  }
  return undefined;
}

/**
 * One element's contract: a non-null, non-array object naming a vocabulary
 * `kind`, carrying only that kind's fields, and a well-formed `frame`. `text`,
 * when present, is a string; the `image` kind may not carry it at all.
 */
function elementProblem(element: unknown): LayerElementsProblem | undefined {
  if (typeof element !== "object" || element === null || Array.isArray(element)) {
    return { path: "", must: "be an object", value: element };
  }
  const record = element as Record<string, unknown>;
  const kind = record.kind;
  if (typeof kind !== "string" || !(HTML_ELEMENT_KINDS as readonly string[]).includes(kind)) {
    return {
      path: ".kind",
      must: `be one of ${HTML_ELEMENT_KINDS.map((value) => `"${value}"`).join(", ")}`,
      value: kind,
    };
  }
  const allowed = ELEMENT_FIELDS[kind as HtmlElementKind];
  for (const [field, value] of Object.entries(record)) {
    if (!allowed.includes(field)) {
      return {
        path: `.${field}`,
        must: `be one of ${allowed.map((key) => `"${key}"`).join(", ")} for element kind "${kind}"`,
        value,
      };
    }
  }
  if (record.text !== undefined && typeof record.text !== "string") {
    return { path: ".text", must: "be a string", value: record.text };
  }
  return frameProblem(record.frame, ".frame");
}

/** A frame's contract (D130): an object of [0, 1] fractions and a vocabulary anchor. */
function frameProblem(frame: unknown, path: string): LayerElementsProblem | undefined {
  if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
    return { path, must: "be an object", value: frame };
  }
  const record = frame as Record<string, unknown>;
  for (const [field, value] of Object.entries(record)) {
    if (!(FRAME_FIELDS as readonly string[]).includes(field)) {
      return {
        path: `${path}.${field}`,
        must: `be one of ${FRAME_FIELDS.map((key) => `"${key}"`).join(", ")}`,
        value,
      };
    }
  }
  for (const field of ["x", "y", "w", "h"] as const) {
    const value = record[field];
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1
    ) {
      return { path: `${path}.${field}`, must: "be a number in [0, 1]", value };
    }
  }
  const anchor = record.anchor;
  if (
    typeof anchor !== "string" ||
    !(ANCHOR_VALUES as readonly string[]).includes(anchor)
  ) {
    return {
      path: `${path}.anchor`,
      must: `be one of ${ANCHOR_VALUES.map((value) => `"${value}"`).join(", ")}`,
      value: anchor,
    };
  }
  return undefined;
}
