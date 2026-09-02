/**
 * The compositor's creative geometry, as fractions of the canvas, in the one
 * browser-safe leaf both the renderer and the web's SVG preview read.
 *
 * `NodeCanvasCompositor` is the single source of truth for what a creative
 * looks like; `CreativePreview` must show the compositor's numbers, not its own
 * (plan 2026-09-01, C1–C5 / D52's SVG half). Keeping the fractions here — a
 * leaf with no runtime dependency at all, like `variation-defaults.ts` — makes
 * constant drift between preview and render structurally impossible: the web
 * imports this through the `./creative-geometry` subpath, never the root
 * barrel, which reaches node builtins.
 *
 * The frozen legacy draw path (D10) keeps its own literals inside
 * `drawLegacy` — its output is byte-pinned by the platform goldens — and every
 * literal there must equal the value below. The timeline draw path and the
 * `prepare`/`fitText` helpers read this object directly.
 */
export const CREATIVE_GEOMETRY = {
  /**
   * Headline type size: a fraction of the canvas WIDTH (`fitText`'s own
   * model), rounded to whole pixels. Not the height — the sign of the
   * preview/render divergence flipped with ratio precisely because the two
   * engines scaled off different axes (C1).
   */
  headlineTypeWidthFraction: 0.06,
  /** Autofit floor: a fraction of the starting type size (`fitText`'s 0.4). */
  headlineTypeFloorFraction: 0.4,
  /** Brand logo block width, as a fraction of the canvas width. */
  logoWidthFraction: 0.16,
  /** Logo margin from the canvas edge, as a fraction of the canvas width. */
  logoMarginFraction: 0.04,
  /** Solid accent band height, flush to the headline edge, × canvas height. */
  accentSolidHeightFraction: 0.05,
  /** Soft fade the accent band melts into, × canvas height (C5). */
  accentFadeHeightFraction: 0.06,
  /**
   * Contrast shade alpha per tone, mirroring `prepare`'s
   * `const shadeAlpha = subtle ? 0.4 : 0.7`.
   */
  shadeAlpha: { bold: 0.7, subtle: 0.4 },
  /**
   * Vertical placement of the headline BLOCK per anchor value, as fractions of
   * the canvas HEIGHT (the anchor axis — plan 2026-09-01, T4). `top` puts the
   * block's top edge at the fraction; `bottom` puts the block's bottom edge
   * (the last baseline) that far above the bottom edge; `middle` centres the
   * wrapped block at that fraction of the SAFE-area height, so insets shift
   * it. The frozen legacy draw path keeps its own literals for the top/bottom
   * edges (D10) — both values here are byte-identical to them — while the
   * layout helpers (`layoutAt`/`settleLayout`) and the web's SVG preview read
   * this object, so the two engines cannot drift.
   */
  headlineAnchor: { top: 0.1, bottom: 0.08, middle: 0.5 },
} as const;
