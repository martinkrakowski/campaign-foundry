import { useId, type CSSProperties, type ReactNode } from "react";
import type { LayoutKind, ToneKind } from "@campaignfoundry/CampaignOrchestration";
import { CREATIVE_GEOMETRY } from "@campaignfoundry/CampaignOrchestration/creative-geometry";
import { DEFAULT_STYLE, type Style } from "@campaignfoundry/CampaignOrchestration/creative-style";
import type { AnchorKind } from "@campaignfoundry/CampaignOrchestration/variation-defaults";
import { RATIO_DIMENSIONS, type AspectRatioValue } from "@campaignfoundry/CampaignOrchestration/aspect-ratios";
import type { MotionKind } from "@campaignfoundry/CampaignOrchestration/motion-kinds";
import { LAYERS, times } from "@/components/ui/preview-layers";
import { cn } from "@/lib/cn";

export type LayoutOption = LayoutKind;
export type ToneOption = ToneKind;
export type AnchorOption = AnchorKind;

export interface CreativePreviewProps {
  readonly layout?: LayoutOption;
  readonly tone?: ToneOption;
  /** Where the headline block sits vertically; absent → derived from `layout` (the pre-axis behaviour). */
  readonly anchor?: AnchorOption;
  readonly primaryColor: string;
  readonly headline?: string;
  readonly motion?: MotionKind;
  /**
   * The brief's creative style (T5). Absent fields → the leaf's defaults, the
   * same `DEFAULT_STYLE` the compositor resolves against — the preview cannot
   * drift from the render on the constants it mirrors.
   */
  readonly style?: Style;
  readonly ratio?: AspectRatioValue;
  readonly className?: string;
}

/** A headline text crams at most this many lines; what does not fit shrinks. */
export const PREVIEW_MAX_LINES = 3;
/**
 * The headline starts at this fraction of the canvas WIDTH — the compositor's
 * `fitText` model, not the height (C1: the divergence's sign flipped with ratio
 * precisely because the two engines scaled off different axes). Reference, not
 * a copy: the domain leaf is the single source of truth.
 */
export const PREVIEW_FONT_RATIO = CREATIVE_GEOMETRY.headlineTypeWidthFraction;
/** The headline never shrinks below this fraction of its starting size (`fitText`'s floor). */
export const PREVIEW_FONT_FLOOR_FRACTION = CREATIVE_GEOMETRY.headlineTypeFloorFraction;
/**
 * The anchor axis' vertical fractions (T4) — references, not copies, exactly
 * like the type fractions above: the compositor's `anchorFirstY` and this SVG
 * must resolve every anchor from the same leaf values.
 */
export const PREVIEW_ANCHOR_TOP = CREATIVE_GEOMETRY.headlineAnchor.top;
export const PREVIEW_ANCHOR_MIDDLE = CREATIVE_GEOMETRY.headlineAnchor.middle;
export const PREVIEW_ANCHOR_BOTTOM = CREATIVE_GEOMETRY.headlineAnchor.bottom;
/**
 * The headline block's vertical fit budget: the canvas minus the leaf's own top
 * and bottom anchor fractions — the same values that place the block — so the
 * computed fit cannot disagree with the drawn position (T4). One source: the
 * budget used to read the miniature's 1/10 for both edges while placement read
 * the leaf's 0.1/0.08, and the two engines' diverged envelopes are exactly the
 * C1 class of drift.
 */
export const previewFitMaxHeight = (height: number): number =>
  height - height * PREVIEW_ANCHOR_TOP - height * PREVIEW_ANCHOR_BOTTOM;
/**
 * Line-to-line spacing as a multiple of the font size — the leaf's default
 * (the compositor's own 1.25, moved there from its literal), not the miniature
 * constant this used to hold. The styled value, when a brief carries one, is
 * resolved per render below; the fit budget and the drawn blocks always agree.
 */
export const LINE_HEIGHT_RATIO = DEFAULT_STYLE.lineHeight;
/** Rough per-glyph advance, in ems, used to plan line breaks without measuring text. */
export const CHAR_WIDTH_RATIO = 0.5;
const SHRINK = 0.9;

/**
 * Tone → weight AS RENDERED (plan D60): only Inter/Lora Regular (400) and Bold
 * (700) faces are registered (`fonts.ts`), so the compositor's `"500"` request
 * for `subtle` silently renders Regular. The preview shows what is rendered —
 * 400 for subtle, 700 for bold — not the requested 500.
 */
const RENDERED_FONT_WEIGHT: Record<ToneKind, number> = { bold: 700, subtle: 400 };

/**
 * One iteration, then rest, holding the final frame: the preview is a live
 * still, not the compositor's loop, and without `forwards` the end pose would
 * snap back to the unanimated frame the instant the iteration ends (D50). The
 * fill-mode lives here, in the one-shot class — NEVER in globals.css, whose
 * keyframes are shared with the glyph's `infinite` loops. Each string is a
 * literal Tailwind class so the scanner emits it; the keyframes and the
 * `--duration-preview`/`--easing-preview` tokens are the ones globals.css
 * already declares (W2b owns them). `motion-safe:` keeps reduced-motion/
 * prefers-reduced a still.
 */
const MOTION_ANIMATION: Record<MotionKind, string> = {
  "ken-burns-in":
    "motion-safe:animate-[kf-ken-burns-in_var(--duration-preview)_var(--easing-preview)_forwards] origin-center",
  "ken-burns-out":
    "motion-safe:animate-[kf-ken-burns-out_var(--duration-preview)_var(--easing-preview)_forwards] origin-center",
  "headline-rise":
    "motion-safe:animate-[kf-headline-rise_var(--duration-preview)_var(--easing-preview)_forwards]",
  "accent-wipe":
    "motion-safe:animate-[kf-accent-wipe_var(--duration-preview)_var(--easing-preview)_forwards] origin-top",
};

export interface FittedHeadline {
  readonly fontSize: number;
  readonly lines: readonly string[];
}

/**
 * Greedy word-wrap: each line takes words up to `maxChars`, breaking between words.
 * When `breakWords` is true, any individual word longer than `maxChars` is split across lines.
 */
export function wrapHeadline(text: string, maxChars: number, breakWords = false): string[] {
  const rawWords = text.split(/\s+/).filter((word) => word.length > 0);
  if (rawWords.length === 0) return [];
  const words: string[] = [];
  if (breakWords) {
    for (const w of rawWords) {
      if (w.length <= maxChars) {
        words.push(w);
      } else {
        for (let i = 0; i < w.length; i += maxChars) {
          words.push(w.slice(i, i + maxChars));
        }
      }
    }
  } else {
    words.push(...rawWords);
  }

  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line.length === 0 ? word : `${line} ${word}`;
    if (candidate.length > maxChars) {
      if (line.length > 0) lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  lines.push(line);
  return lines;
}

/**
 * Fit a headline into the text block: start at `startFontSize` and shrink until it
 * wraps into at most `PREVIEW_MAX_LINES` lines that fit `maxHeight` and `textWidth`,
 * hitting a floor at `minFontSize`. When nothing fits at or above the floor, falls back
 * to `minFontSize` and breaks over-long words so copy never overflows the text block.
 * `lineHeightRatio` is the multiple the fit budget is measured with — the styled
 * value when the brief carries one, the leaf default otherwise.
 */
export function fitHeadline(
  text: string,
  textWidth: number,
  maxHeight: number,
  startFontSize: number,
  minFontSize: number = startFontSize * PREVIEW_FONT_FLOOR_FRACTION,
  lineHeightRatio: number = LINE_HEIGHT_RATIO,
): FittedHeadline {
  const trim = text.trim().replace(/\s+/g, " ");
  if (trim.length === 0) return { fontSize: startFontSize, lines: [] };
  let fontSize = startFontSize;
  while (fontSize >= minFontSize) {
    const maxChars = Math.max(1, Math.floor(textWidth / (CHAR_WIDTH_RATIO * fontSize)));
    const lines = wrapHeadline(trim, maxChars);
    const height = lines.length * fontSize * lineHeightRatio;
    const widestLine = Math.max(...lines.map((l) => l.length), 0);
    if (lines.length <= PREVIEW_MAX_LINES && height <= maxHeight && widestLine <= maxChars) {
      return { fontSize, lines };
    }
    fontSize *= SHRINK;
  }
  const floorChars = Math.max(1, Math.floor(textWidth / (CHAR_WIDTH_RATIO * minFontSize)));
  return { fontSize: minFontSize, lines: wrapHeadline(trim, floorChars, true) };
}

/**
 * The creative the compositor will render, at a real ratio canvas (not the 46-unit
 * miniature): the same layer order and the same geometry, resolved against the
 * ratio's dimensions — photo ground → product-colour accent band flush to the
 * headline edge → the brief's headline as real, centred text → the brand logo's
 * corner, as a neutral block. Every geometry fraction reads the domain's
 * `CREATIVE_GEOMETRY` leaf (the compositor's own constants), so the preview
 * cannot drift from the render (C1–C5). `aria-hidden`: the surface beside it
 * names the campaign, exactly as the miniature's card does. Everything visible
 * is drawn from the brief — no vibes, no footage, no handles, no captions (the
 * D26 fabrication guard).
 */
export function CreativePreview({
  layout,
  tone,
  anchor,
  primaryColor,
  headline,
  motion,
  style,
  ratio = "1:1",
  className,
}: CreativePreviewProps): ReactNode {
  const top = (layout ?? "headline-top") === "headline-top";
  const bold = (tone ?? "bold") === "bold";
  // The anchor axis (T4): absent → derived from `layout`, the compositor's own
  // rule in `prepare` — so an axis-less brief previews exactly as it renders.
  const anchorKind: AnchorKind = anchor ?? (top ? "top" : "bottom");
  // The style block (T5): every absent field resolves to the leaf's default —
  // the same DEFAULT_STYLE the compositor's `resolveStyle` falls back to — so
  // a style-less brief previews exactly as it renders.
  const fontFamily = style?.fontFamily ?? DEFAULT_STYLE.fontFamily;
  const sizeScale = style?.sizeScale ?? DEFAULT_STYLE.sizeScale;
  const lineHeightRatio = style?.lineHeight ?? DEFAULT_STYLE.lineHeight;
  const letterSpacingEm = style?.letterSpacing ?? DEFAULT_STYLE.letterSpacing;
  const align = style?.align ?? DEFAULT_STYLE.align;
  const { width: W, height: H } = RATIO_DIMENSIONS[ratio];
  const shadeAlpha = bold ? CREATIVE_GEOMETRY.shadeAlpha.bold : CREATIVE_GEOMETRY.shadeAlpha.subtle;
  const shadeId = `creative-preview-shade-${useId()}`;
  const fadeId = `creative-preview-fade-${useId()}`;

  const band = H * CREATIVE_GEOMETRY.accentSolidHeightFraction;
  const fadeH = H * CREATIVE_GEOMETRY.accentFadeHeightFraction;
  const textEdge = times(LAYERS.textEdge, W);
  const textWidth = W - 2 * textEdge;
  // The fit budget is the leaf's edge-to-edge envelope (previewFitMaxHeight) —
  // the same fractions that place the block — so the anchor changes where the
  // fitted block sits, never its planned size.
  const maxHeight = previewFitMaxHeight(H);
  const startFontSize = Math.round(W * sizeScale);
  const minFontSize = Math.round(startFontSize * PREVIEW_FONT_FLOOR_FRACTION);
  const { fontSize, lines } = fitHeadline(
    headline ?? "",
    textWidth,
    maxHeight,
    startFontSize,
    minFontSize,
    lineHeightRatio,
  );
  const lineHeight = fontSize * lineHeightRatio;
  const span = (lines.length - 1) * lineHeight;
  // The block's first baseline per anchor, with this SVG's ascent convention
  // (baseline ≈ block top + 0.75 em — the same approximation the top edge has
  // always used). `top`/`bottom` read the leaf's edge fractions; `middle`
  // centres the wrapped block (span + type size) at the leaf's middle fraction
  // of the canvas — the zero-insets form of the compositor's safe-area centre.
  const firstBaseline =
    anchorKind === "top"
      ? H * PREVIEW_ANCHOR_TOP + fontSize * 0.75
      : anchorKind === "middle"
        ? H * PREVIEW_ANCHOR_MIDDLE - (span + fontSize) / 2 + fontSize * 0.75
        : H - H * PREVIEW_ANCHOR_BOTTOM - span;

  // Layer 5 — the brand logo's geometry, opposite corner to the headline by
  // layout (prepare: top headline → bottom-left, bottom headline → top-right).
  // The real logo's height follows its image's aspect; the preview has no
  // access to those pixels, so a square neutral block stands in (D26).
  const logoW = W * CREATIVE_GEOMETRY.logoWidthFraction;
  const logoMargin = W * CREATIVE_GEOMETRY.logoMarginFraction;
  const logoX = top ? logoMargin : W - logoW - logoMargin;

  // The compositor's logo overlap snap, mirrored with this SVG's own line
  // metrics: the headline box is the wrapped block (centred, wrap-budget wide —
  // the same shape the compositor's rule uses, not glyph-measured). Glyph-
  // accurate snap parity is T1b's (plan D52) — real text measurement is
  // explicitly not this lane's bar.
  const headlineBox: Box | undefined =
    lines.length > 0
      ? {
          x: W / 2 - textWidth / 2,
          y: firstBaseline - fontSize,
          width: textWidth,
          height: (lines.length - 1) * lineHeight + fontSize,
        }
      : undefined;
  const logoY = resolveOverlappingLogoY(
    headlineBox,
    { x: logoX, width: logoW, height: logoW },
    H,
    top,
    logoMargin,
  );
  const groundAnim =
    motion === "ken-burns-in" || motion === "ken-burns-out" ? MOTION_ANIMATION[motion] : undefined;
  const textAnim = motion === "headline-rise" ? MOTION_ANIMATION[motion] : undefined;
  const fadeAnim = motion === "accent-wipe" ? MOTION_ANIMATION[motion] : undefined;
  // Alignment (C2), mirrored the way SVG spells it: `textAnchor` + the x the
  // block draws from. Left/right anchor against the text block's own edge —
  // the preview's stand-in for the compositor's safe-area edge (its insets are
  // zero here), so the copy stays inside the drawn budget.
  const textAnchor = align === "left" ? "start" : align === "right" ? "end" : "middle";
  const textX = align === "left" ? textEdge : align === "right" ? W - textEdge : W / 2;

  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      aria-hidden="true"
      focusable="false"
      className={cn("shrink-0", className)}
      style={{ "--c": primaryColor } as CSSProperties}
    >
      <defs>
        <linearGradient
          id={shadeId}
          x1="0"
          y1={top ? LAYERS.shade.start.top : LAYERS.shade.start.bottom}
          x2="0"
          y2={top ? 0 : 1}
        >
          <stop offset="0" stopColor="#000000" stopOpacity={0} />
          <stop offset="1" stopColor="#000000" stopOpacity={shadeAlpha} />
        </linearGradient>
        <linearGradient id={fadeId} x1="0" y1={top ? 0 : 1} x2="0" y2={top ? 1 : 0}>
          {/* The fade starts at full accent colour, continuous with the solid
              band — exactly the compositor's gradient (C5's wrong start). */}
          <stop offset="0" stopColor="var(--c)" stopOpacity={1} />
          <stop offset="1" stopColor="var(--c)" stopOpacity={0} />
        </linearGradient>
      </defs>

      <g className={groundAnim}>
        <rect x="0" y="0" width={W} height={H} className="fill-text-muted" />
        <rect x="0" y="0" width={W} height={H} fill={`url(#${shadeId})`} />
      </g>

      <g>
        <rect
          x="0"
          y={top ? band : H - band - fadeH}
          width={W}
          height={fadeH}
          fill={`url(#${fadeId})`}
          className={fadeAnim}
        />
        <rect x="0" y={top ? 0 : H - band} width={W} height={band} className="fill-[var(--c)]" />
      </g>

      <g className={textAnim}>
        {lines.length > 0 ? (
          <text
            x={textX}
            y={firstBaseline}
            textAnchor={textAnchor}
            fontSize={fontSize}
            // Family and letter spacing are best-effort mirrors: the SVG names
            // the bundled family and applies the em offset, but glyph-accurate
            // parity for both is the server frame's job (T1b, in flight) — no
            // SVG twin can follow Skia's metrics.
            fontFamily={fontFamily}
            letterSpacing={`${letterSpacingEm * fontSize}px`}
            // The weight the compositor renders: an explicitly styled weight
            // (400|700 — the faces that exist, D60) overrides the tone-derived
            // rendered weight.
            fontWeight={style?.fontWeight ?? RENDERED_FONT_WEIGHT[tone ?? "bold"]}
            fill="#ffffff"
          >
            {lines[0]}
            {lines.slice(1).map((line, index) => (
              <tspan key={index} x={textX} dy={lineHeight}>
                {line}
              </tspan>
            ))}
          </text>
        ) : null}
      </g>

      <g>
        {/* Layer 5 — the brand logo's placeholder: a neutral block at the
            compositor's exact geometry (the asset's pixels are not the
            preview's to invent — D26). */}
        <rect
          x={logoX}
          y={logoY}
          width={logoW}
          height={logoW}
          fill="#ffffff"
          fillOpacity={0.4}
        />
      </g>
    </svg>
  );
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Rectangle overlap — the exact predicate `NodeCanvasCompositor` snaps the logo with. */
function boxesOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** The logo y when it rests flush to `edge`, at the given margin (insets are zero here). */
function flushLogoY(edge: "top" | "bottom", height: number, logoH: number): number {
  // A SNAPPED logo goes flush to the safe-inset edge (`insets.top` / bottom in the
  // compositor) — and the preview draws with zero insets, so flush means the canvas
  // edge. Only the REST pose keeps the margin; keeping it here too was a parity miss
  // qodo caught: a snapped logo sat ~4% of the width away from where the render puts it.
  return edge === "top" ? 0 : height - logoH;
}

/**
 * The compositor's logo placement, mirrored exactly — rest AND snap. The rest pose
 * is margined (`prepare`'s rawY at zero insets); only when the headline box overlaps
 * it does the snap begin, and snap targets are FLUSH: the rest edge first, the
 * opposite edge second, and the flush rest edge again if both are blocked.
 * `headlineBox` is undefined when there is no headline to overlap.
 */
export function resolveOverlappingLogoY(
  headlineBox: Box | undefined,
  logo: { readonly x: number; readonly width: number; readonly height: number },
  height: number,
  top: boolean,
  margin: number,
): number {
  const overlaps = (y: number): boolean =>
    headlineBox !== undefined &&
    boxesOverlap(headlineBox, { x: logo.x, y, width: logo.width, height: logo.height });
  // Rest: opposite the headline, margined — exactly `prepare`'s rawY at zero insets.
  const restY = top ? height - logo.height - margin : margin;
  if (!overlaps(restY)) return restY;
  const preferred: "top" | "bottom" = top ? "bottom" : "top";
  const preferredY = flushLogoY(preferred, height, logo.height);
  if (!overlaps(preferredY)) return preferredY;
  const otherY = flushLogoY(preferred === "top" ? "bottom" : "top", height, logo.height);
  if (!overlaps(otherY)) return otherY;
  return preferredY;
}