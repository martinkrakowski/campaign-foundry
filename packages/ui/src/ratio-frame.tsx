import type { ReactNode } from "react";
import type { AspectRatioValue, CanvasSpec } from "@campaignfoundry/CampaignOrchestration/aspect-ratios";
import { canvasSpecOf, frameBox } from "./preview-layers";

export type RatioOption = AspectRatioValue;

/**
 * `spec` is the canvas. `ratio` is a deprecated social-ratio shorthand: the
 * compiler enumerated platform-card, poster-stack, poster-frame and this
 * file's own tests as call sites of the old required `ratio` prop, and
 * existing `{ ratio: "9:16" }` tests must pass unedited.
 */
export type CanvasFrameProps =
  | { readonly spec: CanvasSpec; readonly ratio?: RatioOption }
  | { readonly spec?: never; readonly ratio: RatioOption };

export type RatioFrameProps = CanvasFrameProps & {
  /** The frame's long side in px; the short side follows the true proportion. */
  readonly size?: number;
};

/**
 * A frame drawn at the canvas's true proportion — social ratios and IAB
 * display sizes alike — at theme-token colours so it reads in both themes.
 * Proportions come from `resolveCanvas` via `frameBox`, never a local table:
 * a 728×90 frame is a very wide, very short rectangle (F4). Purely decorative
 * (`aria-hidden`): the name beside it carries the meaning, never the picture.
 */
export function RatioFrame({ spec, ratio, size = 48 }: RatioFrameProps): ReactNode {
  const { width, height } = frameBox(canvasSpecOf(spec, ratio), size);
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
