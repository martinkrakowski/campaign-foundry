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
import type { AspectRatioValue, CanvasSpec } from "./aspect-ratios.js";
import type { DisplaySize } from "./display-sizes.js";
import type { LayerKind } from "./layer-kinds.js";
import type { AnchorKind } from "./variation-defaults.js";

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
 * A rect in canvas fractions: {@link LayerFrame} (D130) minus the vertical
 * `anchor`, which is a placement instruction for copy rather than part of the
 * box. Declared here so a consumer that only needs "where is this box" does
 * not have to invent an anchor value to say it; every `LayerFrame` is already
 * one of these once `byFamily` has been resolved against the current canvas.
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
 * A partial overlay of a {@link LayerFrame}'s box and anchor (D130). `byFamily`
 * maps hold these, never a nested `byFamily` — a second family map on an
 * override is junk, not a second override.
 */
export interface LayerFrameOverride {
  readonly x?: number;
  readonly y?: number;
  readonly w?: number;
  readonly h?: number;
  readonly anchor?: AnchorKind;
}

/**
 * Per-canvas overlays keyed by the canvas family (D130). A `ratio` entry
 * applies only to a social-ratio canvas; a `size` entry applies only to that
 * display size. The two maps never mix: a 300×250 canvas does not consult
 * `ratio`, and a 1:1 canvas does not consult `size`.
 */
export interface LayerFrameByFamily {
  readonly ratio?: Readonly<Partial<Record<AspectRatioValue, LayerFrameOverride>>>;
  readonly size?: Readonly<Partial<Record<DisplaySize, LayerFrameOverride>>>;
}

/**
 * A layer's canvas-relative frame (D130): fractions of the resolved canvas plus
 * the vertical `anchor` vocabulary, with optional per-family overlays. Absent
 * on the layer means the kind's default rect ({@link LAYER_KIND_DEFAULT_RECTS}).
 * Canonical templates never carry one.
 */
export interface LayerFrame {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly anchor: AnchorKind;
  readonly byFamily?: LayerFrameByFamily;
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

/**
 * The frame of the ground a cell generates its background for (D132), or
 * undefined when the ground carries none — which is every canonical template.
 *
 * **The FIRST enabled ground, and the limit is older than this function.** A
 * creative type may accept more than one `image` (it is uncapped in
 * `image-text`), but a cell resolves exactly ONE background and hands it to
 * every ground drawer. Picking the first is therefore not a choice between
 * frames so much as a statement of which layer the single background belongs
 * to; a template that wants two differently-shaped generative grounds needs a
 * background per layer first, which no lane has built.
 *
 * A disabled ground is skipped: it is not drawn, so its box is not what the
 * picture has to fill.
 *
 * Typed structurally rather than against `CreativeTemplateLayer` so this leaf
 * keeps reaching only `layer-kinds` and its own module — the editor imports it
 * through a subpath and must not pull the template validator's dependencies
 * into the browser.
 */
export function groundFrameOf(
  layers: readonly {
    readonly kind: LayerKind;
    readonly enabled?: boolean;
    readonly frame?: LayerFrame;
  }[],
): LayerFrame | undefined {
  for (const layer of layers) {
    if (layer.enabled === false) continue;
    if (isGroundLayerKind(layer.kind)) return layer.frame;
  }
  return undefined;
}

/** The canvas itself, in the fraction units every frame in this vocabulary speaks. */
export const FULL_CANVAS_RECT: CanvasRect = { x: 0, y: 0, w: 1, h: 1 };

/**
 * The default draw rect per layer kind (D130), extracted from the boxes the
 * compositor already paints — not invented. Grounds (`image`, `video`) and
 * every other kind whose drawer fills `(0, 0, width, height)` are
 * {@link FULL_CANVAS_RECT}. Accent is the solid band flush to the default
 * (headline-bottom) edge; logo is the top-right width box; text kinds span
 * the vertical range `headlineAnchor` names. Canonical templates carry no
 * `frame`, so these rects are what "absent means the kind default" equals,
 * asserted against `CREATIVE_GEOMETRY`'s fractions verbatim.
 */
export const LAYER_KIND_DEFAULT_RECTS: Readonly<Record<LayerKind, CanvasRect>> = {
  image: FULL_CANVAS_RECT,
  video: FULL_CANVAS_RECT,
  shade: FULL_CANVAS_RECT,
  fill: FULL_CANVAS_RECT,
  accent: {
    x: 0,
    y: 1 - CREATIVE_GEOMETRY.accentSolidHeightFraction,
    w: 1,
    h: CREATIVE_GEOMETRY.accentSolidHeightFraction,
  },
  logo: {
    x: 1 - CREATIVE_GEOMETRY.logoWidthFraction - CREATIVE_GEOMETRY.logoMarginFraction,
    y: CREATIVE_GEOMETRY.logoMarginFraction,
    w: CREATIVE_GEOMETRY.logoWidthFraction,
    h: CREATIVE_GEOMETRY.logoWidthFraction,
  },
  "static-text": {
    x: 0,
    y: CREATIVE_GEOMETRY.headlineAnchor.top,
    w: 1,
    h: 1 - CREATIVE_GEOMETRY.headlineAnchor.top - CREATIVE_GEOMETRY.headlineAnchor.bottom,
  },
  "animated-text": {
    x: 0,
    y: CREATIVE_GEOMETRY.headlineAnchor.top,
    w: 1,
    h: 1 - CREATIVE_GEOMETRY.headlineAnchor.top - CREATIVE_GEOMETRY.headlineAnchor.bottom,
  },
};

/** The kind's default draw rect — {@link LAYER_KIND_DEFAULT_RECTS}, named once. */
export function defaultLayerRect(kind: LayerKind): CanvasRect {
  return LAYER_KIND_DEFAULT_RECTS[kind];
}

/**
 * Resolve a layer's declared frame against the current canvas family (D130).
 *
 * Absent `frame` returns `undefined` so the compositor keeps today's geometry
 * — byte-identical, which is how canonical templates (no `frame` key) leave
 * the goldens unedited. A present frame overlays `byFamily.ratio` at a social
 * ratio and `byFamily.size` at a display size; the other map is ignored.
 */
export function resolveLayerFrame(
  frame: LayerFrame | undefined,
  spec: CanvasSpec,
): CanvasRect | undefined {
  if (frame === undefined) return undefined;
  const override =
    spec.size !== undefined
      ? frame.byFamily?.size?.[spec.size]
      : frame.byFamily?.ratio?.[spec.ratio];
  return {
    x: override?.x ?? frame.x,
    y: override?.y ?? frame.y,
    w: override?.w ?? frame.w,
    h: override?.h ?? frame.h,
  };
}
