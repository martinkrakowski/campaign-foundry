import { useId, type ReactNode } from "react";
import type { LayoutKind, ToneKind } from "@campaignfoundry/CampaignOrchestration";

export type LayoutOption = LayoutKind;
export type ToneOption = ToneKind;

export interface CreativeGlyphProps {
  readonly layout?: LayoutOption;
  readonly tone?: ToneOption;
  readonly size?: number;
}

const VIEWBOX = 46;
/** The compositor's solid accent band: height * 0.05 (NodeCanvasCompositor.draw, layer 3). */
const BAND = 2.3;
/** Edge offset of the text block, ≈ the compositor's headline anchor (height * 0.1). */
const TEXT_EDGE = 8;
const BAR_GAP = 3;

/**
 * A miniature of the creative the compositor will draw, in its layer order
 * (NodeCanvasCompositor.draw): photo ground → contrast shade on the headline
 * edge → brand accent band flush to that edge → text. `layout` picks the edge;
 * `tone` scales the shade and the text weight. The arrangement mirrors the
 * compositor, not the pixels — colours are theme tokens so the glyph reads in
 * both themes, and the whole drawing is `aria-hidden`: the label carries the
 * meaning, never the picture.
 */
export function CreativeGlyph({ layout, tone, size = 46 }: CreativeGlyphProps): ReactNode {
  // An axis card previews one axis at a time; the omitted prop falls back to a
  // fixed representative value so every glyph still has an edge and a weight.
  const top = (layout ?? "headline-top") === "headline-top";
  const bold = (tone ?? "bold") === "bold";
  // tone → shadeAlpha / text weight, mirroring NodeCanvasCompositor.prepare:
  // `const shadeAlpha = subtle ? 0.4 : 0.7` and `fontWeight = subtle ? "500" : "bold"`.
  const shadeAlpha = bold ? 0.7 : 0.4;
  const barHeight = bold ? 4 : 2.5;
  // The shade gradient starts where the compositor's does: 0.55h / 0.45h,
  // darkest at the headline edge (NodeCanvasCompositor.draw, layer 2).
  const gradientId = `creative-glyph-shade-${useId()}`;
  const longBarY = top ? TEXT_EDGE : VIEWBOX - TEXT_EDGE - barHeight;
  const shortBarY = top ? longBarY + barHeight + BAR_GAP : longBarY - BAR_GAP - barHeight;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
      aria-hidden="true"
      focusable="false"
      className="shrink-0 text-background"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1={top ? "0.55" : "0.45"} x2="0" y2={top ? "0" : "1"}>
          <stop offset="0" stopColor="currentColor" stopOpacity={0} />
          <stop offset="1" stopColor="currentColor" stopOpacity={shadeAlpha} />
        </linearGradient>
      </defs>
      {/* Layer 1 — photo ground (text-muted: the neutral placeholder). */}
      <rect x="0" y="0" width={VIEWBOX} height={VIEWBOX} className="fill-text-muted" />
      {/* Layer 2 — contrast shade on the headline edge, fading into the image. */}
      <rect x="0" y="0" width={VIEWBOX} height={VIEWBOX} fill={`url(#${gradientId})`} />
      {/* Layer 3 — brand accent band flush to the headline edge. */}
      <rect x="0" y={top ? 0 : VIEWBOX - BAND} width={VIEWBOX} height={BAND} className="fill-brand-primary" />
      {/* Layer 4 — the message as two bars; tone sets their weight. */}
      <rect x="10" y={longBarY} width="26" height={barHeight} rx={barHeight / 2} className="fill-text-primary" />
      <rect x="15" y={shortBarY} width="16" height={barHeight} rx={barHeight / 2} className="fill-text-primary" />
    </svg>
  );
}
