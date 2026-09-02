import { useId, type CSSProperties, type ReactNode } from "react";
import type { LayoutKind, ToneKind } from "@campaignfoundry/CampaignOrchestration";
import { CREATIVE_GEOMETRY } from "@campaignfoundry/CampaignOrchestration/creative-geometry";
import { RATIO_DIMENSIONS, type AspectRatioValue } from "@campaignfoundry/CampaignOrchestration/aspect-ratios";
import type { MotionKind } from "@campaignfoundry/CampaignOrchestration/motion-kinds";
import { LAYERS, times } from "@/components/ui/preview-layers";
import { cn } from "@/lib/cn";

export type LayoutOption = LayoutKind;
export type ToneOption = ToneKind;

export interface CreativePreviewProps {
  readonly layout?: LayoutOption;
  readonly tone?: ToneOption;
  readonly primaryColor: string;
  readonly headline?: string;
  readonly motion?: MotionKind;
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
/** Line-to-line spacing as a multiple of the font size. */
export const LINE_HEIGHT_RATIO = 1.08;
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
 */
export function fitHeadline(
  text: string,
  textWidth: number,
  maxHeight: number,
  startFontSize: number,
  minFontSize: number = startFontSize * PREVIEW_FONT_FLOOR_FRACTION,
): FittedHeadline {
  const trim = text.trim().replace(/\s+/g, " ");
  if (trim.length === 0) return { fontSize: startFontSize, lines: [] };
  let fontSize = startFontSize;
  while (fontSize >= minFontSize) {
    const maxChars = Math.max(1, Math.floor(textWidth / (CHAR_WIDTH_RATIO * fontSize)));
    const lines = wrapHeadline(trim, maxChars);
    const height = lines.length * fontSize * LINE_HEIGHT_RATIO;
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
  primaryColor,
  headline,
  motion,
  ratio = "1:1",
  className,
}: CreativePreviewProps): ReactNode {
  const top = (layout ?? "headline-top") === "headline-top";
  const bold = (tone ?? "bold") === "bold";
  const { width: W, height: H } = RATIO_DIMENSIONS[ratio];
  const shadeAlpha = bold ? CREATIVE_GEOMETRY.shadeAlpha.bold : CREATIVE_GEOMETRY.shadeAlpha.subtle;
  const shadeId = `creative-preview-shade-${useId()}`;
  const fadeId = `creative-preview-fade-${useId()}`;

  const band = H * CREATIVE_GEOMETRY.accentSolidHeightFraction;
  const fadeH = H * CREATIVE_GEOMETRY.accentFadeHeightFraction;
  const anchor = times(LAYERS.headlineAnchor, H);
  const textEdge = times(LAYERS.textEdge, W);
  const textWidth = W - 2 * textEdge;
  const maxHeight = H - 2 * anchor;
  const startFontSize = Math.round(W * PREVIEW_FONT_RATIO);
  const minFontSize = Math.round(startFontSize * PREVIEW_FONT_FLOOR_FRACTION);
  const { fontSize, lines } = fitHeadline(headline ?? "", textWidth, maxHeight, startFontSize, minFontSize);
  const lineHeight = fontSize * LINE_HEIGHT_RATIO;
  const firstBaseline = top
    ? anchor + fontSize * 0.75
    : H - anchor - (lines.length - 1) * lineHeight;

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
            x={W / 2}
            y={firstBaseline}
            textAnchor="middle"
            fontSize={fontSize}
            fontFamily="var(--font-sans)"
            fontWeight={RENDERED_FONT_WEIGHT[tone ?? "bold"]}
            fill="#ffffff"
          >
            {lines[0]}
            {lines.slice(1).map((line, index) => (
              <tspan key={index} x={W / 2} dy={lineHeight}>
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