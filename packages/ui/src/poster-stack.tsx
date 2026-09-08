import type { ReactNode } from "react";
import type { CanvasSpec } from "@campaignfoundry/CampaignOrchestration/aspect-ratios";
import { PosterFrame, frameSize, type PosterVariant } from "./poster-frame";
import { canvasSpecOf } from "./preview-layers";
import type { RatioOption } from "./ratio-frame";

export interface PosterStackProps {
  /** The canvas every frame in the stack shares. Wins over `ratio`. */
  readonly spec?: CanvasSpec;
  /**
   * @deprecated Prefer `spec`. Social-ratio shorthand kept so existing
   * `{ ratio: "9:16" }` call sites type-check.
   */
  readonly ratio?: RatioOption;
  /** Each frame's long side in px. */
  readonly size?: number;
}

/** Union-keyed, like every variant table in this kit — a fourth is a compile error. */
const VARIANTS: readonly PosterVariant[] = ["pA", "pB", "pC"];

const OFFSET_X = 8;
const OFFSET_Y = 6;

/**
 * Three poster skeletons drawn overlapping, offset by a few px each — the
 * static replacement for the mockup's three-frame cross-fade (§2.2): the
 * *set* of layouts a mode can produce, all visible at once. Wholly decorative
 * and purely static — no animation classes anywhere (D88).
 */
export function PosterStack({ spec, ratio = "1:1", size = 84 }: PosterStackProps): ReactNode {
  const canvas = canvasSpecOf(spec, ratio);
  const { width, height } = frameSize(canvas, size);
  return (
    <span
      aria-hidden="true"
      className="relative inline-block"
      style={{
        width: width + (VARIANTS.length - 1) * OFFSET_X,
        height: height + (VARIANTS.length - 1) * OFFSET_Y,
      }}
    >
      {VARIANTS.map((variant, index) => (
        <span
          key={variant}
          className="absolute"
          style={{ left: index * OFFSET_X, top: index * OFFSET_Y }}
        >
          <PosterFrame spec={canvas} variant={variant} size={size} />
        </span>
      ))}
    </span>
  );
}
