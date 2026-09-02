/**
 * Layer geometry for the two web components that paint the compositor's look:
 * `CreativeGlyph` (the 46 px axis-card miniature) and, through the domain leaf,
 * `CreativePreview` (a real canvas per ratio).
 *
 * The real fractions of `NodeCanvasCompositor.draw` live in the domain's
 * browser-safe leaf (`@campaignfoundry/CampaignOrchestration/creative-geometry`);
 * `CreativePreview` reads them from there, so preview and render cannot drift.
 * What remains here is the miniature's own proportions — several are deliberate
 * quirks of the 46 px box (an 8/46 text edge that only approximates the
 * compositor's 0.1 anchor, a 14/46 fade that is nothing like the real 0.06,
 * message bars the real preview does not draw), and their output is pinned
 * byte-for-byte by `creative-glyph.byte-identity.test.tsx`.
 *
 * Fractions are held as numerators/denominators (`{ n, d }`) rather than
 * decimals because the miniature's output is pinned byte-for-byte by
 * `creative-glyph.byte-identity.test.tsx`: `46 × 0.05` does not round-trip to
 * the same double as the literal `2.3`, while `(46 × 1) / 20` does. `times`
 * multiplies numerator-first for exactly that reason.
 */
import { CREATIVE_GEOMETRY } from "@campaignfoundry/CampaignOrchestration/creative-geometry";

/** The unit box the miniature draws in — a 46 px square. */
export const PREVIEW_BOX = 46;

/** A measurement as a clean fraction of its box, e.g. `{ n: 8, d: 46 }`. */
export interface BoxFraction {
  readonly n: number;
  readonly d: number;
}

/**
 * Scale a box-fraction onto an arbitrary size: `size × n / d`, numerator first so
 * a clean rational (`8/46` of 46, `25/460` of 46) round-trips to its exact value.
 */
export const times = ({ n, d }: BoxFraction, size: number): number => (size * n) / d;

/** Scale a box-fraction onto the fixed 46-unit miniature box. */
export const fractionOfBox = (fraction: BoxFraction): number => times(fraction, PREVIEW_BOX);

/**
 * The compositor's layers as fractions of the box, in the order
 * `NodeCanvasCompositor.draw` paints them. Every number the two previews draw
 * resolves from here.
 */
export const LAYERS = {
  /** Layer 3 — the solid accent band: height × 0.05. */
  band: { n: 1, d: 20 },
  /** Layer 4 — the headline block's edge inset; the miniature's 8 px ≈ height × 0.1. */
  textEdge: { n: 8, d: 46 },
  /** Layer 4 — the compositor's headline anchor: height × 0.1 (the real-size preview). */
  headlineAnchor: { n: 1, d: 10 },
  /** The gap between the two miniature message bars. */
  barGap: { n: 3, d: 46 },
  /** Layer 3 — the soft fade the accent band melts into (the accent-wipe layer). */
  fadeHeight: { n: 14, d: 46 },
  /** Layer 4 — the message bars as the miniature draws them. */
  longBar: { x: { n: 10, d: 46 }, width: { n: 26, d: 46 } },
  shortBar: { x: { n: 15, d: 46 }, width: { n: 16, d: 46 } },
  /** Layer 4 — tone → bar thickness, i.e. the compositor's font weight. */
  weight: { bold: { n: 4, d: 46 }, subtle: { n: 5, d: 92 } },
  shade: {
    /**
     * Layer 2 — tone → shade alpha, the exact object the domain leaf exports,
     * mirroring `NodeCanvasCompositor.prepare`'s `subtle ? 0.4 : 0.7`. Kept as
     * a reference (not a copy) so the miniature cannot drift from the render.
     */
    alpha: CREATIVE_GEOMETRY.shadeAlpha,
    /** Layer 2 — where the contrast gradient starts: 0.55 h top / 0.45 h bottom. */
    start: { top: 0.55, bottom: 0.45 },
  },
} as const;