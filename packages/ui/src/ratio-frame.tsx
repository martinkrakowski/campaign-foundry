import type { ReactNode } from "react";
import type { AspectRatioValue } from "@campaignfoundry/CampaignOrchestration/aspect-ratios";

export type RatioOption = AspectRatioValue;

export interface RatioFrameProps {
  readonly ratio: RatioOption;
  /** The frame's long side in px; the short side follows the true proportion. */
  readonly size?: number;
}

/**
 * Union-keyed lookups rather than `=== "9:16"` comparisons: a Record over the
 * domain union makes a new member a *compile* error instead of a branch that
 * cannot be covered under the 100 % gate. Same idiom as `TOP_EDGE` in
 * `creative-glyph.tsx`.
 */
const PROPORTIONS: Record<RatioOption, { width: number; height: number }> = {
  "1:1": { width: 1, height: 1 },
  "9:16": { width: 9, height: 16 },
  "16:9": { width: 16, height: 9 },
};

/**
 * A frame drawn at the ratio's true proportion — the square, tall and wide
 * canvases the compositor renders — at theme-token colours so it reads in both
 * themes. Purely decorative (`aria-hidden`): the ratio's name beside it carries
 * the meaning, never the picture.
 */
export function RatioFrame({ ratio, size = 48 }: RatioFrameProps): ReactNode {
  const { width: w, height: h } = PROPORTIONS[ratio];
  const long = Math.max(w, h);
  const width = (w / long) * size;
  const height = (h / long) * size;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      {/* The canvas at its true proportion: a hairline frame on a raised surface. */}
      <rect
        x={0.75}
        y={0.75}
        width={width - 1.5}
        height={height - 1.5}
        rx={1.5}
        strokeWidth={1.5}
        className="fill-surface-2 stroke-border"
      />
    </svg>
  );
}
