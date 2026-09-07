import type { ReactNode } from "react";
import type { RatioOption } from "./ratio-frame";

export type PosterVariant = "pA" | "pB" | "pC";

export interface PosterFrameProps {
  /** The ratio's true proportion — union-keyed like `RatioFrame`, so a fourth is a compile error. */
  readonly ratio: RatioOption;
  /** The layout variant: image-top, image-left, or centred. */
  readonly variant: PosterVariant;
  /** The frame's long side in px; the short side follows the true proportion. */
  readonly size?: number;
  /** The "start blank" card: a dashed empty frame, no content layers. */
  readonly blank?: boolean;
}

/** Union-keyed proportions, copied from `RatioFrame` — one source, no drift. */
const PROPORTIONS: Record<RatioOption, { width: number; height: number }> = {
  "1:1": { width: 1, height: 1 },
  "9:16": { width: 9, height: 16 },
  "16:9": { width: 16, height: 9 },
};

/**
 * The mockup's four content layers, each one token fill via Tailwind's
 * `color-mix` scale — never `--rgb-*`, never a hex. The frame itself is
 * `RatioFrame`'s hairline idiom (`fill-surface-2 stroke-border`).
 */
const IMAGE = "fill-text-muted/18";
const IMAGE_TINTED = "fill-brand-primary/80";
const HEADLINE = "fill-text-secondary/50";
const SUBHEAD = "fill-text-secondary/30";
const CTA = "fill-brand-primary";

interface Layer {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rx?: number;
  readonly fill: string;
}

/**
 * Union-keyed layout lookups rather than `=== "pA"` comparisons: a Record over
 * the variant union makes a new member a *compile* error instead of a branch
 * that cannot be covered under the 100 % gate. Same idiom as `PROPORTIONS`
 * above and `TOP_EDGE` in `creative-glyph.tsx`. Each table returns the variant's
 * four content layers — image block, headline bar, subhead bar, CTA chip — as
 * fractions of the frame's own box, so one table holds at every ratio.
 */
const LAYOUTS: Record<PosterVariant, (w: number, h: number) => readonly Layer[]> = {
  // pA — image on top, headline and subhead beneath, CTA bottom-left.
  pA: (w, h) => [
    { x: 0.09 * w, y: 0.07 * h, width: 0.82 * w, height: 0.52 * h, fill: IMAGE },
    { x: 0.09 * w, y: 0.67 * h, width: 0.62 * w, height: 0.05 * h, fill: HEADLINE },
    { x: 0.09 * w, y: 0.75 * h, width: 0.46 * w, height: 0.04 * h, fill: SUBHEAD },
    { x: 0.09 * w, y: 0.86 * h, width: 0.3 * w, height: 0.08 * h, rx: 0.04 * h, fill: CTA },
  ],
  // pB — image left (tinted), text right, round avatar bottom-right.
  pB: (w, h) => [
    { x: 0.07 * w, y: 0.08 * h, width: 0.38 * w, height: 0.84 * h, fill: IMAGE_TINTED },
    { x: 0.53 * w, y: 0.16 * h, width: 0.36 * w, height: 0.05 * h, fill: HEADLINE },
    { x: 0.53 * w, y: 0.25 * h, width: 0.28 * w, height: 0.04 * h, fill: SUBHEAD },
    { x: 0.53 * w, y: 0.83 * h, width: 0.24 * w, height: 0.08 * h, rx: 0.04 * h, fill: CTA },
  ],
  // pC — centred round image, centred text, CTA centred.
  pC: (w, h) => {
    const r = 0.2 * Math.min(w, h);
    return [
      { x: 0.5 * w - r, y: 0.36 * h - r, width: 2 * r, height: 2 * r, rx: r, fill: IMAGE },
      { x: 0.24 * w, y: 0.64 * h, width: 0.52 * w, height: 0.05 * h, fill: HEADLINE },
      { x: 0.3 * w, y: 0.72 * h, width: 0.4 * w, height: 0.04 * h, fill: SUBHEAD },
      { x: 0.38 * w, y: 0.83 * h, width: 0.24 * w, height: 0.08 * h, rx: 0.04 * h, fill: CTA },
    ];
  },
};

const AVATAR_FRACTION = 0.055;

/**
 * A miniature poster at one of the domain's true ratios — the mockup's `.f` +
 * `.fv` skeleton: a hairline frame holding four layered content rects. Wholly
 * decorative (`aria-hidden`): the tile's accessible name carries the meaning,
 * never the picture. Static by construction — no animation classes anywhere.
 */
export function PosterFrame({ ratio, variant, size = 96, blank = false }: PosterFrameProps): ReactNode {
  const { width: rw, height: rh } = PROPORTIONS[ratio];
  const long = Math.max(rw, rh);
  const w = (rw / long) * size;
  const h = (rh / long) * size;
  const layers = blank ? [] : LAYOUTS[variant](w, h);
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <rect
        x={0.75}
        y={0.75}
        width={w - 1.5}
        height={h - 1.5}
        rx={1.5}
        strokeWidth={1.5}
        className="fill-surface-2 stroke-border"
        {...(blank ? { strokeDasharray: "4 3" } : {})}
      />
      {layers.map((layer, index) => (
        <rect
          key={index}
          x={layer.x}
          y={layer.y}
          width={layer.width}
          height={layer.height}
          {...(layer.rx === undefined ? {} : { rx: layer.rx })}
          className={layer.fill}
        />
      ))}
      {/* pB's round avatar sits outside the four-layer table: it is decoration on the variant, not a layer. */}
      {variant === "pB" && !blank ? (
        <circle
          cx={0.88 * w}
          cy={0.88 * h}
          r={AVATAR_FRACTION * Math.min(w, h)}
          className={IMAGE}
        />
      ) : null}
    </svg>
  );
}
