/**
 * The HTML layer's element vocabulary and its validation (HL1, HL-D1, HL-D2).
 *
 * An `html` layer holds *elements*, not layers (HL-D1). Each element is
 * `{ kind, text?, style?, frame }`, constrained to the kinds both renderers
 * can express — `text`, `button`, `image` (HL-D2) — so the canvas compositor
 * and the markup assembler draw the same creative from one list. The `style`
 * override (HL5e, HL-D8) is the two fields both renderers already read
 * identically, and `htmlElementFont` below is the ONE resolution they share;
 * a future click destination arrives with the lane that reads it, never as an
 * unread field (the D134 lesson).
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
import {
  FONT_FAMILY_VALUES,
  FONT_WEIGHT_VALUES,
  type FontFamilyKind,
  type FontWeightKind,
} from "./creative-style.js";
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
 * A per-element style override (HL5e, HL-D4, HL-D8): exactly the two fields
 * both renderers read the same way for both text kinds — the brief's `Style`
 * narrowed to what markup and canvas can honour identically. Every field is
 * optional and an absent one means "use the brief's resolved value", the same
 * optional-override shape D134 props take; the vocabularies are
 * `creative-style`'s, never restated here.
 */
export interface HtmlElementStyle {
  readonly fontWeight?: FontWeightKind;
  readonly fontFamily?: FontFamilyKind;
}

/**
 * One element inside an `html` layer. `text` is the copy the `text` and
 * `button` kinds carry and cannot render without, and the `image` kind must
 * not; every element positions itself with a `frame`, and the two kinds that
 * render copy may override the brief's font with a `style` (HL5e). The
 * interface keeps `text` optional because an untrusted value reaches the
 * domain as `unknown` and only `layerElementsProblem` may admit it — but the
 * validator requires it on the kinds whose field table marks it required.
 */
export interface HtmlElement {
  readonly kind: HtmlElementKind;
  readonly text?: string;
  readonly style?: HtmlElementStyle;
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
 * One kind's fields: the keys it may carry, in declaration order, and which of
 * them it cannot mean anything without. `required` is a subset of `allowed`;
 * keeping both in one table means the two can never disagree about a kind, the
 * way a parallel `if` branch could.
 */
interface ElementFieldSpec {
  /** The keys the kind may carry, in declaration order. */
  readonly allowed: readonly string[];
  /** The keys every element of the kind must carry; absent means the element renders nothing. */
  readonly required: readonly string[];
}

/**
 * The fields each element kind carries. The `image` kind names no `text` and
 * no `style`, so the field table — not a second branch — refuses copy and
 * font overrides on an image, exactly as `LAYER_PROPS` refuses another kind's
 * props; and the `text` and `button` kinds mark `text` required, so the same
 * table refuses an element that would render nothing rather than letting one
 * reach HL2. `style` sits between `text` and `frame` in each kind's order —
 * what it says about the copy belongs beside the copy it restyles (HL5e).
 */
const ELEMENT_FIELDS: Readonly<Record<HtmlElementKind, ElementFieldSpec>> = {
  text: { allowed: ["kind", "text", "style", "frame"], required: ["text"] },
  button: { allowed: ["kind", "text", "style", "frame"], required: ["text"] },
  image: { allowed: ["kind", "frame"], required: [] },
};

/** A frame's fields (D130), in declaration order. */
const FRAME_FIELDS = ["x", "y", "w", "h", "anchor"] as const;

/** An element style block's fields (HL5e), in declaration order. */
const ELEMENT_STYLE_FIELDS = ["fontWeight", "fontFamily"] as const;

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
 * `kind`, carrying only that kind's fields, carrying every field the kind marks
 * required, and a well-formed `frame`. `text`, when present, is a string; the
 * `image` kind may not carry it at all.
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
  const { allowed, required } = ELEMENT_FIELDS[kind as HtmlElementKind];
  for (const [field, value] of Object.entries(record)) {
    if (!allowed.includes(field)) {
      return {
        path: `.${field}`,
        must: `be one of ${allowed.map((key) => `"${key}"`).join(", ")} for element kind "${kind}"`,
        value,
      };
    }
  }
  for (const field of required) {
    if (record[field] === undefined) {
      return { path: `.${field}`, must: "be present", value: record[field] };
    }
  }
  if (record.text !== undefined && typeof record.text !== "string") {
    return { path: ".text", must: "be a string", value: record.text };
  }
  if (record.style !== undefined) {
    const styleIssue = elementStyleProblem(record.style);
    if (styleIssue !== undefined) {
      return { path: `.style${styleIssue.path}`, must: styleIssue.must, value: styleIssue.value };
    }
  }
  return frameProblem(record.frame, ".frame");
}

/**
 * One element's `style` block (HL5e): an object carrying only the two
 * vocabulary overrides, each a present-and-vocabulary value or absent. An
 * empty block is ACCEPTED, deliberately: every field of an optional-override
 * block is optional, so `style: {}` asserts exactly what the absent key
 * asserts and resolves identically — and refusing it would make an element's
 * style block stricter than the brief's own, which `styleProblem` and the
 * parser accept as `{}` today (D54). The editor still never writes one: its
 * reducer drops an all-absent style, the X16 canonical form.
 */
function elementStyleProblem(
  style: unknown,
): { path: string; must: string; value: unknown } | undefined {
  if (typeof style !== "object" || style === null || Array.isArray(style)) {
    return { path: "", must: "be an object", value: style };
  }
  const record = style as Record<string, unknown>;
  for (const [field, value] of Object.entries(record)) {
    if (!(ELEMENT_STYLE_FIELDS as readonly string[]).includes(field)) {
      return {
        path: `.${field}`,
        must: `be one of ${ELEMENT_STYLE_FIELDS.map((key) => `"${key}"`).join(", ")}`,
        value,
      };
    }
  }
  const { fontWeight, fontFamily } = record;
  if (
    fontWeight !== undefined &&
    !(FONT_WEIGHT_VALUES as readonly number[]).includes(fontWeight as number)
  ) {
    return {
      path: ".fontWeight",
      must: `be one of ${FONT_WEIGHT_VALUES.join(", ")}`,
      value: fontWeight,
    };
  }
  if (
    fontFamily !== undefined &&
    !(FONT_FAMILY_VALUES as readonly string[]).includes(fontFamily as string)
  ) {
    return {
      path: ".fontFamily",
      must: `be one of ${FONT_FAMILY_VALUES.map((value) => `"${value}"`).join(", ")}`,
      value: fontFamily,
    };
  }
  return undefined;
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

/**
 * The one per-element font resolution (HL5e, HL-D4/HL-D8): the element's own
 * override when it names one, the brief-level resolved font otherwise. The
 * brief-level pair arrives already resolved — `resolveStyle` has folded in the
 * brief's `creative-style` and the tone-derived weight — so an absent override
 * needs no third fallback here, and neither renderer spells a `??` of its own:
 * `assembleHtml` and `drawHtml` both call THIS for both text kinds, which is
 * what keeps a weight or family the markup emits from ever disagreeing with
 * the canvas fallback that draws the same element (HL-D5). An `image` element
 * can carry no style (the field table refuses it), so its resolution is always
 * the brief's — the renderers simply never ask.
 */
export interface ElementFont {
  readonly fontWeight: string;
  readonly fontFamily: string;
}

export function htmlElementFont(element: HtmlElement, briefFont: ElementFont): ElementFont {
  return {
    fontWeight:
      element.style?.fontWeight !== undefined
        ? String(element.style.fontWeight)
        : briefFont.fontWeight,
    fontFamily: element.style?.fontFamily ?? briefFont.fontFamily,
  };
}

/**
 * An element's text geometry (HL5f, HL-D5/HL-D8): the font size both renderers
 * derive for a `text` element, gathered here so `drawHtml` (the canvas) and
 * `assembleHtml` (the markup) read ONE function instead of each restating the
 * same two-term min — the box's own 0.7-of-height cap (never below 12px, X10's
 * legibility floor) against the brief's `sizeScale` at the canvas's own basis.
 * `lineHeight` and `letterSpacing` are plain products of the resolved font
 * size; gathering them costs nothing and keeps a future third reader from
 * restating them a third way.
 */
export interface HtmlTextGeometryInput {
  readonly boxH: number;
  readonly canvasBasis: number;
  readonly sizeScale: number;
  readonly lineHeight: number;
  readonly letterSpacing: number;
}

export interface HtmlTextGeometry {
  readonly fontSize: number;
  /** Pixels — `fontSize * lineHeight` multiplier, not the bare CSS multiplier. */
  readonly lineHeight: number;
  /** Pixels — `letterSpacing` em fraction resolved against `fontSize`. */
  readonly letterSpacing: number;
}

export function htmlTextGeometry(input: HtmlTextGeometryInput): HtmlTextGeometry {
  const fontSize = Math.min(
    Math.max(12, Math.round(input.boxH * 0.7)),
    Math.round(input.canvasBasis * input.sizeScale),
  );
  return {
    fontSize,
    lineHeight: fontSize * input.lineHeight,
    letterSpacing: input.letterSpacing * fontSize,
  };
}

/**
 * The `button` element's font size (HL5f): the box's own 0.45-of-height cap
 * against a fixed 0.6-of-canvas-basis ceiling. One shared source for the
 * canvas drawer and the markup assembler, which already computed the exact
 * same two-term min independently — item 3 of the HL5f change, confirmed
 * identical and now pinned rather than merely coincidental.
 */
export function htmlButtonFontSize(boxH: number, canvasBasis: number): number {
  return Math.min(Math.round(boxH * 0.45), Math.round(canvasBasis * 0.6));
}

/**
 * The canvas's per-anchor vertical placement (HL5f, HL-D5/HL-D8): the offset
 * from the element's frame TOP to the first line's alphabetic BASELINE,
 * replicating `drawHtml`'s three anchor branches exactly (`top`: flush by one
 * `fontSize`; `middle`: the wrapped block's span centred in the box, offset by
 * a fixed `fontSize * 0.35` baseline correction; `bottom`: the block's span
 * flush to the box's bottom edge). `drawHtml` calls this with the REAL
 * post-wrap line count (`wrapText` measures the real font first) — a
 * byte-identical refactor of what was three inline branches.
 *
 * `assembleHtml` does NOT call this (orchestrator fix round, HL5f): a first
 * attempt converted this baseline offset into a markup `padding-top` computed
 * for a single line, which is exact for `top` but WRONG for any `middle` or
 * `bottom` text that actually wraps to more than one line in the browser —
 * assembling is server-side with no browser to know the real line count in
 * (D122), and a fixed single-line padding pushes line 2+ below the box, where
 * `overflow: hidden` clips it. The markup instead positions with CSS flex
 * `justify-content`, which the browser resolves against however many lines
 * the text actually takes — structurally correct for any line count. The
 * residual against the canvas (stated in the plan, not narrowed here) is the
 * baseline-correction constant above (`fontSize * 0.35` for `middle`; the
 * canvas anchors to the alphabetic baseline, the browser's flex centring to
 * the line box), which does not vary with line count either way.
 */
export function htmlTextFirstLineOffset(
  anchor: AnchorKind,
  boxH: number,
  fontSize: number,
  lineHeight: number,
  lineCount: number,
): number {
  const totalSpan = (lineCount - 1) * lineHeight;
  if (anchor === "top") return fontSize;
  if (anchor === "middle") return (boxH - totalSpan) / 2 + fontSize * 0.35;
  return boxH - totalSpan;
}
