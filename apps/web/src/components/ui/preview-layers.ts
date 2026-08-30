/**
 * The compositor's layer geometry, as fractions of a drawing box, shared by
 * the two components that paint it at screen scale: `CreativeGlyph` (the 46 px
 * axis-card miniature) and `CreativePreview` (a real canvas per ratio). Both
 * resolve the same fractions against their own box, so the two cannot drift
 * from each other — and the shape they both draw is the one
 * `NodeCanvasCompositor.draw` paints, of which these are the proportions:
 *
 *   - layer 2  the contrast shade, darkest at the headline edge (start 0.55 h
 *              on a top headline, 0.45 h on a bottom one; alpha per tone)
 *   - layer 3  the solid brand accent band, exactly height × 0.05, flush to
 *              the headline edge, plus a soft fade into the image
 *   - layer 4  the headline block, its edge inset ≈ height × 0.1
 *
 * The miniature's geometry is quirky (an 8/46 text edge that only approximates
 * the compositor's 0.1 anchor, a 26 px long bar); those quirks live here, in
 * shared form, so a change lands in miniature and preview at once and always
 * against the same source numbers.
 *
 * Fractions are held as numerators/denominators (`{ n, d }`) rather than
 * decimals because the miniature's output is pinned byte-for-byte by
 * `creative-glyph.byte-identity.test.tsx`: `46 × 0.05` does not round-trip to
 * the same double as the literal `2.3`, while `(46 × 1) / 20` does. `times`
 * multiplies numerator-first for exactly that reason.
 */

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
     * Layer 2 — tone → shade alpha, mirroring `NodeCanvasCompositor.prepare`:
     * `const shadeAlpha = subtle ? 0.4 : 0.7`.
     */
    alpha: { bold: 0.7, subtle: 0.4 },
    /** Layer 2 — where the contrast gradient starts: 0.55 h top / 0.45 h bottom. */
    start: { top: 0.55, bottom: 0.45 },
  },
} as const;