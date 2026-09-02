import { CREATIVE_GEOMETRY } from "./creative-geometry.js";

/**
 * The brief-level creative `style` block (plan 2026-09-01, T5): typography that
 * applies to every creative the brief renders, classic and variation alike.
 *
 * NOT a variation axis (a new axis is parse-rejected and a hashed one trips
 * D57) and NOT a `Treatment` widening (classic-only). It is hashed nowhere —
 * `policyHash` is untouched by construction — so a styled brief and its
 * style-less twin resolve to the same plan.
 *
 * This leaf has no runtime dependency beyond the geometry leaf, like
 * `variation-defaults.ts`: the web app reads it through the `./creative-style`
 * subpath, never the root barrel, which reaches node builtins. Every field is
 * optional and its default equals today's literal (D54 — a style-less brief is
 * bit-identical), so `DEFAULT_STYLE` and the vocabulary below are the one
 * source the parser, the compositor and the preview all read.
 */

/**
 * The font families a brief may name (D59): exactly the bundled, OFL-licensed
 * faces `fonts.ts` registers — an allowlist, not a free-text family. Anything
 * else is rejected at parse and at `MESSAGE_FONT` by the same vocabulary.
 */
export const FONT_FAMILY_VALUES = ["Inter", "Lora"] as const;
export type FontFamilyKind = (typeof FONT_FAMILY_VALUES)[number];

/**
 * The weights a brief may request (D60): only the weights that have faces.
 * Inter/Lora ship Regular (400) and Bold (700) only — a 100–900 slider would be
 * decorative over four faces (100–500 render Regular, 600–800 Bold, 900 is
 * synthetic emboldening).
 */
export const FONT_WEIGHT_VALUES = [400, 700] as const;
export type FontWeightKind = (typeof FONT_WEIGHT_VALUES)[number];

/** Headline alignment (C2 — the renderer used to centre unconditionally). */
export const ALIGN_VALUES = ["left", "center", "right"] as const;
export type AlignKind = (typeof ALIGN_VALUES)[number];

/** `sizeScale` bounds: a fraction of the canvas WIDTH (D55), like `fitText`. */
export const MIN_SIZE_SCALE = 0.02;
export const MAX_SIZE_SCALE = 0.12;
/** `lineHeight` bounds: a multiple of the font size. */
export const MIN_LINE_HEIGHT = 1.0;
export const MAX_LINE_HEIGHT = 1.8;
/** `letterSpacing` bounds: an em fraction (px = em × fontSize). */
export const MIN_LETTER_SPACING = -0.05;
export const MAX_LETTER_SPACING = 0.2;

/**
 * The style block exactly as a brief spells it: every field optional, absent →
 * today's behaviour. `fontWeight` absent means tone-derived (`subtle` asks for
 * "500" and renders Regular, `bold` renders 700 — D60's collapse); present, it
 * overrides the tone.
 */
export interface Style {
  readonly fontFamily?: FontFamilyKind;
  readonly fontWeight?: FontWeightKind;
  readonly sizeScale?: number;
  readonly lineHeight?: number;
  readonly letterSpacing?: number;
  readonly align?: AlignKind;
}

/**
 * The defaults, each equal to today's literal (D54): type at the geometry
 * leaf's width fraction, the compositor's 1.25 line multiple (moved here from
 * its literal in `layoutAt`), zero letter spacing, centred text, Inter.
 */
export const DEFAULT_STYLE: Readonly<{
  fontFamily: FontFamilyKind;
  sizeScale: number;
  lineHeight: number;
  letterSpacing: number;
  align: AlignKind;
}> = {
  fontFamily: "Inter",
  sizeScale: CREATIVE_GEOMETRY.headlineTypeWidthFraction,
  lineHeight: 1.25,
  letterSpacing: 0,
  align: "center",
};

/**
 * The style as the renderer consumes it: no absent fields, and the weight
 * resolved to the string the canvas font shorthand spells — the tone-derived
 * literal when the brief did not name one (D54 byte-identity), the styled
 * weight otherwise. Built once in `NodeCanvasCompositor.prepare`.
 */
export interface ResolvedStyle {
  /** string, not the kind: the adapter's own contract accepts any family name; the allowlist is enforced at parse (brief) and pipeline (`MESSAGE_FONT`), not here. */
  readonly fontFamily: string;
  readonly fontWeight: string;
  readonly sizeScale: number;
  readonly lineHeight: number;
  readonly letterSpacing: number;
  readonly align: AlignKind;
}

/**
 * Resolve an optional brief style: the tone-derived weight stands when the
 * brief named none, and the deployment font family (the adapter's own default)
 * stands when it named no family.
 */
export function resolveStyle(
  style: Style | undefined,
  fallbackWeight: string,
  fallbackFamily: string = DEFAULT_STYLE.fontFamily,
): ResolvedStyle {
  return {
    fontFamily: style?.fontFamily ?? fallbackFamily,
    fontWeight: style?.fontWeight !== undefined ? String(style.fontWeight) : fallbackWeight,
    sizeScale: style?.sizeScale ?? DEFAULT_STYLE.sizeScale,
    lineHeight: style?.lineHeight ?? DEFAULT_STYLE.lineHeight,
    letterSpacing: style?.letterSpacing ?? DEFAULT_STYLE.letterSpacing,
    align: style?.align ?? DEFAULT_STYLE.align,
  };
}

/**
 * The style block's structural validation — the ONE validator both boundaries
 * that accept a brief call (T5): `load-brief`'s parser and
 * `GenerateCampaignUseCase.validateBrief` (defense-in-depth for callers that
 * bypass parsing, exactly the `Treatment.vo` SAFE_ID precedent). Numeric style
 * fields arrive as unbounded numbers from such callers, so the use case must
 * reject what the parser rejects — and sharing this function is what keeps the
 * two boundaries from drifting. The messages are the parser's own, verbatim
 * (its tests pin them). The `timelineProblem` shape: the problem sentence, or
 * undefined when the block is legal.
 */
export function styleProblem(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  // The same narrowing every neighbouring validator in `load-brief` spells
  // (`isPlainObject`): an object, not null, not an array.
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return 'Campaign brief field "style" must be an object.';
  }
  const record = value as Record<string, unknown>;
  const STYLE_FIELDS = [
    "fontFamily",
    "fontWeight",
    "sizeScale",
    "lineHeight",
    "letterSpacing",
    "align",
  ] as const;
  for (const key of Object.keys(record)) {
    if (!(STYLE_FIELDS as readonly string[]).includes(key)) {
      return `Unsupported style field "${key}" (allowed: ${STYLE_FIELDS.join(", ")}).`;
    }
  }
  const finiteIn = (field: string, v: unknown, min: number, max: number, why: string): string | undefined =>
    v === undefined
      ? undefined
      : typeof v !== "number" || !Number.isFinite(v) || v < min || v > max
        ? `Campaign brief field "style.${field}" must be a finite number in [${min}, ${max}] (${why}).`
        : undefined;
  if (record.fontFamily !== undefined && !(FONT_FAMILY_VALUES as readonly string[]).includes(record.fontFamily as string)) {
    return `Campaign brief field "style.fontFamily" must be one of ${FONT_FAMILY_VALUES.join(", ")}.`;
  }
  if (record.fontWeight !== undefined && !(FONT_WEIGHT_VALUES as readonly number[]).includes(record.fontWeight as number)) {
    return `Campaign brief field "style.fontWeight" must be one of ${FONT_WEIGHT_VALUES.join(", ")} (D60: only the weights that have faces).`;
  }
  const size = finiteIn("sizeScale", record.sizeScale, MIN_SIZE_SCALE, MAX_SIZE_SCALE, "a fraction of the canvas width, D55");
  if (size !== undefined) return size;
  const line = finiteIn("lineHeight", record.lineHeight, MIN_LINE_HEIGHT, MAX_LINE_HEIGHT, "a multiple of the font size");
  if (line !== undefined) return line;
  const spacing = finiteIn("letterSpacing", record.letterSpacing, MIN_LETTER_SPACING, MAX_LETTER_SPACING, "an em fraction");
  if (spacing !== undefined) return spacing;
  if (record.align !== undefined && !(ALIGN_VALUES as readonly string[]).includes(record.align as string)) {
    return `Campaign brief field "style.align" must be one of ${ALIGN_VALUES.join(", ")}.`;
  }
  return undefined;
}

/** True when any field diverges from the defaults — what makes the block worth writing. */
export function styleDiverges(style: Style | undefined): boolean {
  return (
    style !== undefined &&
    ((style.fontFamily !== undefined && style.fontFamily !== DEFAULT_STYLE.fontFamily) ||
      style.fontWeight !== undefined ||
      (style.sizeScale !== undefined && style.sizeScale !== DEFAULT_STYLE.sizeScale) ||
      (style.lineHeight !== undefined && style.lineHeight !== DEFAULT_STYLE.lineHeight) ||
      (style.letterSpacing !== undefined && style.letterSpacing !== DEFAULT_STYLE.letterSpacing) ||
      (style.align !== undefined && style.align !== DEFAULT_STYLE.align))
  );
}
