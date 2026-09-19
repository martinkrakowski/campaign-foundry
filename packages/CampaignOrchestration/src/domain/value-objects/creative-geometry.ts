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
 *
 * CE2 adds the other half of the same job: not a fraction each drawer scales
 * by, but the one box a whole KIND of layer occupies — see
 * {@link GROUND_LAYER_KINDS} at the foot of the file. The import is type-only,
 * so the leaf still has no runtime dependency at all.
 */
import type { LayerKind } from "./layer-kinds.js";

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
  /**
   * The text effects (T6), the one source both draw paths read — like the
   * anchor fractions, so the renderer and any future preview cannot drift.
   * Every kind plays on a beat's OWN local progress over the entrance window
   * and eases with the motion kinds' easeOutCubic; at the window's end (and on
   * the still/poster path) each kind is the identity pose — the rest pose the
   * still delivers (H4/D54). Offsets are canvas fractions, matching the
   * width/height-fraction model the rest of this leaf speaks.
   */
  textEffect: {
    /** Entrance window: the share of the beat-local progress the entrance takes. */
    entranceFraction: 0.3,
    /** rise-in: the block starts this far BELOW its rest pose, × canvas height. */
    riseOffsetFraction: 0.08,
    /** slide-in: the block starts this far RIGHT of its rest pose, × canvas width. */
    slideOffsetFraction: 0.2,
    /** scale-in: the block starts scaled down by this fraction, easing to 1. */
    scaleAmplitude: 0.12,
  },
} as const;

/**
 * A rect in canvas fractions: `Frame` (D130) minus the vertical `anchor`, which
 * is a placement instruction for copy rather than part of the box. Declared
 * here so a consumer that only needs "where is this box" does not have to
 * invent an anchor value to say it; every `Frame` is already one of these.
 */

/**
 * The prop → default pairing, named once (SE2).
 *
 * Which `CREATIVE_GEOMETRY` constant a given layer kind's prop overrides. It
 * was written inline at each compositor call site and nowhere else, so the
 * editor had no way to ask "is this prop already the default?" without
 * restating the pairing — and a second statement of it is a second geometry,
 * which is the thing `CREATIVE_GEOMETRY` exists to prevent.
 *
 * **Only the MERGED quantities appear here**, and the omissions are deliberate:
 * `static-text`/`animated-text`'s `anchor` and `shade`'s `alpha` each shadow a
 * variation axis (the anchor axis, the tone axis), and which of the prop or the
 * axis wins is an open owner decision (C4's reduced scope). They have no default
 * to be equal to, so they are never dropped as redundant. `image`'s `alt` is not
 * a geometry at all.
 */
export const LAYER_PROP_DEFAULTS = {
  accent: {
    solidHeight: CREATIVE_GEOMETRY.accentSolidHeightFraction,
    fadeHeight: CREATIVE_GEOMETRY.accentFadeHeightFraction,
  },
  logo: {
    width: CREATIVE_GEOMETRY.logoWidthFraction,
    margin: CREATIVE_GEOMETRY.logoMarginFraction,
  },
  "static-text": { typeFloor: CREATIVE_GEOMETRY.headlineTypeFloorFraction },
  "animated-text": { typeFloor: CREATIVE_GEOMETRY.headlineTypeFloorFraction },
} as const satisfies Readonly<Record<string, Readonly<Record<string, number>>>>;

/**
 * The default this prop overrides, or `undefined` when it overrides none.
 *
 * The one question both the compositor's merge and the editor's canonicaliser
 * ask, so neither spells the pairing itself.
 */
export function layerPropDefault(kind: string, field: string): number | undefined {
  const forKind = (
    LAYER_PROP_DEFAULTS as Readonly<Record<string, Readonly<Record<string, number>>>>
  )[kind];
  return forKind === undefined ? undefined : forKind[field];
}

export interface CanvasRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * The GROUND kinds (CE2): the layer kinds whose drawer is `paintBackground`.
 *
 * Both entries dispatch to that one drawer in the compositor's `LAYER_DRAWERS`
 * table — `image` for a still's picture, `video` for a clip's — and it paints
 * through `drawGroundImage`, whose call is
 * `ctx.drawImage(image, 0, 0, width, height)`. So a ground layer's box is the
 * canvas itself: {@link FULL_CANVAS_RECT}, exactly, with no fraction left to
 * get wrong. The ken-burns poses scale ABOUT THE CENTRE between
 * `1 + KEN_BURNS_ZOOM` and `1` and never below 1, so neither synthesised
 * ground motion uncovers a corner. A hand-authored `scale` track (K4) can go
 * below 1, and the rect stays this one anyway: the rect is the layer's DRAW
 * rect, and a pose transform is not geometry — the same class as the window
 * `PreviewHitRegions` already names, where a region and the last fetched
 * raster disagree for one debounce.
 *
 * The set lives here rather than in the web, and
 * `NodeCanvasCompositor.ground-kinds.test.ts` pins it against `LAYER_DRAWERS`
 * itself: give `video` a drawer of its own, or point a third kind at
 * `paintBackground`, and that test fails rather than a hit region silently
 * claiming a canvas it no longer covers. That guard is the whole reason this is
 * an export and not a two-element array inside a component — the same reason
 * the fractions above are here, stated by this file's own opening paragraph.
 *
 * `shade` is NOT a member, though `paintShade` also fills
 * `(0, 0, width, height)`: it fills with a gradient that starts at
 * `rgba(0, 0, 0, 0)` and reaches at most `0.7`, so it owns no pixel anywhere —
 * it is a veil over the ground rather than something standing in the ground's
 * place. What that means for hit testing is the web's decision (see
 * `PreviewHitRegions.tsx`), not this leaf's.
 */
export const GROUND_LAYER_KINDS: readonly LayerKind[] = ["image", "video"];

/** Whether a layer kind's drawer paints the whole canvas — see {@link GROUND_LAYER_KINDS}. */
export function isGroundLayerKind(kind: LayerKind): boolean {
  return GROUND_LAYER_KINDS.includes(kind);
}

/** The canvas itself, in the fraction units every frame in this vocabulary speaks. */
export const FULL_CANVAS_RECT: CanvasRect = { x: 0, y: 0, w: 1, h: 1 };
