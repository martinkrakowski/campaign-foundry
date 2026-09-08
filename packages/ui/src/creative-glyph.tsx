import { useId, type ReactNode } from "react";
import type { LayoutKind, ToneKind } from "@campaignfoundry/CampaignOrchestration";
import type { MotionKind } from "@campaignfoundry/CampaignOrchestration/motion-kinds";
import { LAYERS, PREVIEW_BOX, fractionOfBox } from "./preview-layers";

export type LayoutOption = LayoutKind;
export type ToneOption = ToneKind;

export interface CreativeGlyphProps {
  readonly layout?: LayoutOption;
  readonly tone?: ToneOption;
  readonly motion?: MotionKind;
  readonly size?: number;
}

/**
 * Union-keyed lookups rather than `=== "headline-top"` comparisons: a Record over the
 * domain union makes a new member a *compile* error, while a `switch` with a `never`
 * default would add a branch that is unreachable by construction and cannot be covered
 * under the 100 % gate. Same idiom as `REST_T` in `MotionKind.vo.ts`.
 */
const TOP_EDGE: Record<LayoutKind, boolean> = { "headline-top": true, "headline-bottom": false };
const HEAVY: Record<ToneKind, boolean> = { bold: true, subtle: false };

const VIEWBOX = PREVIEW_BOX;
/**
 * Every geometry constant resolves from `preview-layers` — the same fractions the
 * compositor proportions derive from (band = height * 0.05, headline edge ≈ height * 0.1,
 * accent shade alpha per tone) — so the miniature and `CreativePreview` share one source
 * and cannot drift. Each number is *bit-identical* to the value it replaced, which
 * `creative-glyph.byte-identity.test.tsx` proves byte-for-byte against the captured golden.
 */
const BAND = fractionOfBox(LAYERS.band);
const fadeHeight = fractionOfBox(LAYERS.fadeHeight);
const TEXT_EDGE = fractionOfBox(LAYERS.textEdge);
const BAR_GAP = fractionOfBox(LAYERS.barGap);
const longBarX = fractionOfBox(LAYERS.longBar.x);
const longBarWidth = fractionOfBox(LAYERS.longBar.width);
const shortBarX = fractionOfBox(LAYERS.shortBar.x);
const shortBarWidth = fractionOfBox(LAYERS.shortBar.width);

/**
 * A miniature of the creative the compositor will draw, in its layer order
 * (NodeCanvasCompositor.draw): photo ground → contrast shade on the headline
 * edge → brand accent band flush to that edge → text. `layout` picks the edge;
 * `tone` scales the shade and the text weight. `motion` animates the corresponding
 * group via CSS keyframes with an always-present cue glyph fallback for reduced
 * motion and disabled states. The entire SVG is `aria-hidden`: the label carries
 * the meaning, never the picture.
 */
export function CreativeGlyph({ layout, tone, motion, size = 46 }: CreativeGlyphProps): ReactNode {
  // An axis card previews one axis at a time; the omitted prop falls back to a
  // fixed representative value so every glyph still has an edge and a weight.
  const top = TOP_EDGE[layout ?? "headline-top"];
  const bold = HEAVY[tone ?? "bold"];
  // tone → shadeAlpha / text weight, mirroring NodeCanvasCompositor.prepare:
  // `const shadeAlpha = subtle ? 0.4 : 0.7` and `fontWeight = subtle ? "500" : "bold"`.
  const shadeAlpha = bold ? LAYERS.shade.alpha.bold : LAYERS.shade.alpha.subtle;
  const barHeight = bold ? fractionOfBox(LAYERS.weight.bold) : fractionOfBox(LAYERS.weight.subtle);
  // The shade gradient starts where the compositor's does: 0.55h / 0.45h,
  // darkest at the headline edge (NodeCanvasCompositor.draw, layer 2).
  const gradientId = `creative-glyph-shade-${useId()}`;
  const fadeGradientId = `creative-glyph-fade-${useId()}`;
  const longBarY = top ? TEXT_EDGE : VIEWBOX - TEXT_EDGE - barHeight;
  const shortBarY = top ? longBarY + barHeight + BAR_GAP : longBarY - BAR_GAP - barHeight;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
      {...(motion !== undefined ? { "data-motion": motion } : {})}
    >
      <defs>
        {/*
          Deliberately a literal black, not a theme token: the compositor's shade is
          `rgba(0, 0, 0, shadeAlpha)` in every context (NodeCanvasCompositor.draw, layer 2),
          so the miniature must darken the headline edge in the light theme too. Deriving it
          from `--color-background` would invert it there (#ffffff), and the card would
          misrepresent the creative it is previewing.
        */}
        <linearGradient id={gradientId} x1="0" y1={top ? LAYERS.shade.start.top : LAYERS.shade.start.bottom} x2="0" y2={top ? "0" : "1"}>
          <stop offset="0" stopColor="#000000" stopOpacity={0} />
          <stop offset="1" stopColor="#000000" stopOpacity={shadeAlpha} />
        </linearGradient>
        <linearGradient id={fadeGradientId} x1="0" y1={top ? "0" : "1"} x2="0" y2={top ? "1" : "0"}>
          <stop offset="0" stopColor="var(--color-brand-primary)" stopOpacity={0.6} />
          <stop offset="1" stopColor="var(--color-brand-primary)" stopOpacity={0} />
        </linearGradient>
      </defs>

      {/* Group 1 — Ground layer (photo ground + shade gradient). */}
      <g className="glyph-anim glyph-ground">
        {/* Layer 1 — photo ground (text-muted: the neutral placeholder). */}
        <rect x="0" y="0" width={VIEWBOX} height={VIEWBOX} className="fill-text-muted" />
        {/* Layer 2 — contrast shade on the headline edge, fading into the image. */}
        <rect x="0" y="0" width={VIEWBOX} height={VIEWBOX} fill={`url(#${gradientId})`} />
      </g>

      {/* Group 2 — Accent band & soft fade layer for accent-wipe. */}
      <g className="glyph-band-group">
        <rect
          x="0"
          y={top ? BAND : VIEWBOX - BAND - fadeHeight}
          width={VIEWBOX}
          height={fadeHeight}
          fill={`url(#${fadeGradientId})`}
          className="glyph-anim glyph-fade"
        />
        {/* Layer 3 — brand accent band flush to the headline edge. */}
        <rect x="0" y={top ? 0 : VIEWBOX - BAND} width={VIEWBOX} height={BAND} className="fill-brand-primary" />
      </g>

      {/* Group 3 — Text bars (headline message). */}
      <g className="glyph-anim glyph-text">
        {/* Layer 4 — the message as two bars; tone sets their weight. */}
        <rect x={longBarX} y={longBarY} width={longBarWidth} height={barHeight} rx={barHeight / 2} className="fill-text-primary" />
        <rect x={shortBarX} y={shortBarY} width={shortBarWidth} height={barHeight} rx={barHeight / 2} className="fill-text-primary" />
      </g>

      {/* Group 4 — Directional cue group (always rendered; revealed when reduced-motion/disabled). */}
      <g className="glyph-cue" aria-hidden="true">
        {motion === "ken-burns-in" ? (
          <g stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-white">
            <path d="M 6 6 L 14 14 M 14 6 L 14 14 L 6 14" />
            <path d="M 40 40 L 32 32 M 32 40 L 32 32 L 40 32" />
          </g>
        ) : null}
        {motion === "ken-burns-out" ? (
          <g stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-white">
            <path d="M 14 14 L 6 6 M 14 6 L 6 6 L 6 14" />
            <path d="M 32 32 L 40 40 M 32 40 L 40 40 L 40 32" />
          </g>
        ) : null}
        {motion === "headline-rise" ? (
          <g stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-white">
            <path d="M 23 34 L 23 18 M 17 24 L 23 18 L 29 24" />
          </g>
        ) : null}
        {motion === "accent-wipe" ? (
          <g stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-white">
            <path d={top ? "M 23 8 L 23 24 M 17 18 L 23 24 L 29 18" : "M 23 38 L 23 22 M 17 28 L 23 22 L 29 28"} />
          </g>
        ) : null}
      </g>
    </svg>
  );
}

