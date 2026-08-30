import { useId, type CSSProperties, type ReactNode } from "react";
import type { LayoutKind, ToneKind } from "@campaignfoundry/CampaignOrchestration";
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
/** The headline starts at this fraction of the canvas height (then shrinks to fit). */
export const PREVIEW_FONT_RATIO = 0.09;
/** The headline never shrinks below this fraction of the canvas height. */
export const PREVIEW_MIN_FONT_RATIO = 0.05;
/** Line-to-line spacing as a multiple of the font size. */
export const LINE_HEIGHT_RATIO = 1.08;
/** Rough per-glyph advance, in ems, used to plan line breaks without measuring text. */
const CHAR_WIDTH_RATIO = 0.5;
const SHRINK = 0.9;

/**
 * One iteration, then rest: the preview is a live still, not the compositor's loop.
 * Each string is a literal Tailwind class so the scanner emits it; the keyframes and
 * the `--duration-preview`/`--easing-preview` tokens are the ones globals.css already
 * declares (W2b owns them). `motion-safe:` keeps reduced-motion/prefers-reduced a still.
 */
const MOTION_ANIMATION: Record<MotionKind, string> = {
  "ken-burns-in": "motion-safe:animate-[kf-ken-burns-in_var(--duration-preview)_var(--easing-preview)] origin-center",
  "ken-burns-out": "motion-safe:animate-[kf-ken-burns-out_var(--duration-preview)_var(--easing-preview)] origin-center",
  "headline-rise": "motion-safe:animate-[kf-headline-rise_var(--duration-preview)_var(--easing-preview)]",
  "accent-wipe": "motion-safe:animate-[kf-accent-wipe_var(--duration-preview)_var(--easing-preview)] origin-top",
};

export interface FittedHeadline {
  readonly fontSize: number;
  readonly lines: readonly string[];
}

/** Greedy word-wrap: each line takes words up to `maxChars`, breaking between words. */
export function wrapHeadline(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return [];
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
 * wraps into at most `PREVIEW_MAX_LINES` lines that fit `maxHeight`, hitting a floor
 * only when a long word or the floor itself gives out. Pure and deterministic, so
 * the preview's SVG text stays byte-stable for a given brief.
 */
export function fitHeadline(
  text: string,
  textWidth: number,
  maxHeight: number,
  startFontSize: number,
): FittedHeadline {
  const trim = text.trim().replace(/\s+/g, " ");
  if (trim.length === 0) return { fontSize: startFontSize, lines: [] };
  const minFontSize = startFontSize * PREVIEW_MIN_FONT_RATIO;
  let fontSize = startFontSize;
  while (fontSize >= minFontSize) {
    const maxChars = Math.max(1, Math.floor(textWidth / (CHAR_WIDTH_RATIO * fontSize)));
    const lines = wrapHeadline(trim, maxChars);
    const height = lines.length * fontSize * LINE_HEIGHT_RATIO;
    if (lines.length <= PREVIEW_MAX_LINES && height <= maxHeight) return { fontSize, lines };
    fontSize *= SHRINK;
  }
  const floor = Math.max(1, Math.floor(textWidth / (CHAR_WIDTH_RATIO * fontSize)));
  return { fontSize, lines: wrapHeadline(trim, floor) };
}

/**
 * The creative the compositor will render, at a real ratio canvas (not the 46-unit
 * miniature): the same layer order and the same box fractions, resolved against the
 * ratio's dimensions — photo ground → product-colour accent band flush to the headline
 * edge → the brief's headline as real text. `aria-hidden`: the surface beside it names
 * the campaign, exactly as the miniature's card does. Everything visible is drawn from
 * the brief — no vibes, no footage, no handles, no captions (the D26 fabrication guard).
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
  const shadeAlpha = bold ? LAYERS.shade.alpha.bold : LAYERS.shade.alpha.subtle;
  const shadeId = `creative-preview-shade-${useId()}`;
  const fadeId = `creative-preview-fade-${useId()}`;

  const band = times(LAYERS.band, H);
  const fadeH = times(LAYERS.fadeHeight, H);
  const anchor = times(LAYERS.headlineAnchor, H);
  const textEdge = times(LAYERS.textEdge, W);
  const textWidth = W - 2 * textEdge;
  const maxHeight = H - 2 * anchor;
  const { fontSize, lines } = fitHeadline(headline ?? "", textWidth, maxHeight, H * PREVIEW_FONT_RATIO);
  const lineHeight = fontSize * LINE_HEIGHT_RATIO;
  const firstBaseline = top
    ? anchor + fontSize * 0.75
    : H - anchor - (lines.length - 1) * lineHeight;

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
          <stop offset="0" stopColor="var(--c)" stopOpacity={0.6} />
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
            x={textEdge}
            y={firstBaseline}
            fontFamily="var(--font-sans)"
            fontWeight={bold ? 700 : 500}
            className="fill-text-primary"
          >
            {lines[0]}
            {lines.slice(1).map((line, index) => (
              <tspan key={index} x={textEdge} dy={lineHeight}>
                {line}
              </tspan>
            ))}
          </text>
        ) : null}
      </g>
    </svg>
  );
}