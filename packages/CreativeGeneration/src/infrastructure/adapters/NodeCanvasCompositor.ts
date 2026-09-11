import { readFile } from "node:fs/promises";
import { createCanvas, loadImage, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import {
  CANONICAL_TEMPLATES,
  beatAt,
  resolveCanvas,
  resolveTimeline,
  resolveStyle,
  scaleBasis,
  widthTermBasis,
  type CanvasSpec,
  type CompositeRequest,
  type CompositeResult,
  type CompositorPort,
  type CopyTimeline,
  type MotionKind,
  type ResolvedBeat,
  type ResolvedStyle,
  type SafeInsets,
  type AnchorKind,
  type TextEffectKind,
  type BriefTemplate,
  type CreativeTemplateLayer,
  type CreativeType,
  type LayerKind,
} from "@campaignfoundry/CampaignOrchestration";
import { CREATIVE_GEOMETRY } from "@campaignfoundry/CampaignOrchestration/creative-geometry";
import { hexToRgb, wrapText } from "./canvas-util.js";
import { registerBundledFonts } from "../fonts.js";
import { resolveAssetPath } from "../safe-path.js";

// Re-export so A2's compositor tests keep importing from this module; the
// functions live in the domain (lint:arch — the editor must not reach here).
export { scaleBasis, widthTermBasis };

/**
 * Everything {@link NodeCanvasCompositor.draw} needs to blit a still (or a later
 * motion frame). Images and logo geometry are loaded once in
 * {@link NodeCanvasCompositor.prepare}; wrapping stays on the real drawing
 * context so measureText matches the blit.
 *
 * Module-private: the `@generated` barrels `export *` this file, so exporting
 * this type (or prepare/draw as free functions) would leak it — and through it
 * `@napi-rs/canvas` `Image` / `SKRSContext2D` — from
 * `@campaignfoundry/CreativeGeneration`. Hexagen has no non-barreled `internal`
 * export path.
 */
interface PreparedCreative {
  readonly canvas: CanvasSpec;
  readonly width: number;
  readonly height: number;
  readonly top: boolean;
  /**
   * Where the headline block sits vertically (T4). Resolved in `prepare`:
   * absent request anchor → derived from `layout` (`headline-top` → `top`,
   * else `bottom`), so a request without the axis takes exactly today's path
   * and numbers (D54). The shade/accent edge stays `top`'s — `layout`'s —
   * and only the text block moves.
   */
  readonly anchor: AnchorKind;
  readonly shadeAlpha: number;
  readonly fontWeight: string;
  readonly fontFamily: string;
  /**
   * The resolved creative style (T5): every field concrete, absent request
   * fields → today's literals (D54). `fontWeight`/`fontFamily` above are the
   * same values, kept as flat fields because the ctx.font shorthand reads them
   * at every layout and blit.
   */
  readonly style: ResolvedStyle;
  /**
   * The text effect (T6), resolved here in `prepare`: undefined = none — the
   * pre-effect path bit for bit (D54). Present, it drives ONLY the copy
   * layer's entrance on the beat-local clock, composing with any motion kind
   * (translations add, alphas multiply); at rest every kind is the identity,
   * so stills and posters are byte-identical to the effect-less brief (H4).
   */
  readonly textEffect: TextEffectKind | undefined;
  readonly message: string;
  readonly brandColor: string;
  readonly background: Image;
  readonly logo:
    | {
        readonly image: Image;
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
      }
    | undefined;
  /**
   * Brand-compliance signal: whether the logo drawer actually painted. Derived
   * in `prepare` as *logo file loaded AND the resolved layer list contains a
   * `logo` layer* — the load alone is not the signal, the layer is optional
   * (F2), and a template that omits it draws no logo pixels.
   */
  readonly logoApplied: boolean;
  /** Normalized safe-zone insets; zeros when the request omitted them. */
  readonly insets: SafeInsets;
  /**
   * The resolved draw order (D121/D128): array position is z-order, bottom
   * first. Resolved once in `prepare` — the request's `template.layers` when
   * the caller passes the L1b brief template, else the canonical layers for
   * its creative type, else the `image-text` canonical list
   * ({@link resolveLayerList}) — and iterated in full by both draw paths:
   * `drawLegacy` over the whole list through the {@link LAYER_DRAWERS} table,
   * `drawTimeline` (C1/C5) over the whole list too, dispatching the sequenced
   * copy kinds to its own beat drawer at their list position instead of the
   * table (see {@link logoAnchorLayout} for how the logo stays order-agnostic
   * on both paths).
   */
  readonly layers: readonly CreativeTemplateLayer[];
  /**
   * Resolved beat windows when the request carried `copy.timeline` + `durationSec`;
   * undefined = the legacy single-message path (D10). All three scene fields are
   * set together in `prepare`, never per frame.
   */
  readonly timeline?: readonly ResolvedBeat[];
  /**
   * Per-text layout at the D6 common type size, keyed by beat text and memoized
   * once in `prepare`, so `draw` never re-wraps (M4).
   */
  readonly beatLayouts?: ReadonlyMap<string, HeadlineLayout>;
  /** The key beat's layout: what the poster shows (D7). */
  readonly anchorLayout?: HeadlineLayout;
  /**
   * What the logo drawer snaps against, on EITHER draw path (C5): the key
   * beat's layout ({@link anchorLayout}) when the request resolved a
   * timeline, else the message's own fitted layout, measured once here on a
   * throwaway context the same way {@link resolveBeatLayouts} measures beats
   * — SKIA's text metrics don't depend on the canvas's backing size, so this
   * matches what the real blit context measures at draw time (proven already
   * by the timeline path's byte-identity goldens). `undefined` when the
   * resolved layer list carries no `static-text`/`animated-text` layer at
   * all — there is no text block for the logo to snap to, and {@link drawLogo}
   * throws rather than guessing one. Resolving this in `prepare`, independent
   * of where `logo` sits in the list, is what lets a template put the logo
   * ABOVE its text layer (order the still path used to refuse, and the
   * motion path used to ignore) without either path caring which drawer ran
   * first.
   */
  readonly logoAnchorLayout?: HeadlineLayout;
}

/**
 * One layer drawer: a verbatim block of the former legacy blit (D121),
 * parameterized by the shared draw context — no bespoke per-layer signatures.
 */
type LayerDrawer = (c: LayerDrawContext) => void;

/**
 * Everything a layer drawer reads: the real blit context, the prepared
 * creative, and the pose values the draw path computed once. One object serves
 * every drawer (D121). The logo's overlap snap reads its anchor box off
 * `prepared.logoAnchorLayout` (C5) — resolved once in `prepare`, independent
 * of draw order — so this context carries no drawer-to-drawer handoff field.
 */
interface LayerDrawContext {
  readonly ctx: SKRSContext2D;
  readonly prepared: PreparedCreative;
  readonly motion: MotionKind | undefined;
  readonly eased: number;
  readonly effectT: number;
}

/**
 * Kind → drawer (D121): the draw order is the template's layer list; this
 * table owns kind → code. `animated-text` maps to the same drawer as
 * `static-text` (D127): the kind names the capability and its props select
 * which mechanism drives it, and a still frame of animated text is its rest
 * pose — exactly what drawStaticText paints; the moving path is L6/L11's.
 * `video` maps to the same drawer as `image` (VD): video is the output frame
 * sequence rather than an input asset, and on any single frame the background
 * is a still image blit (with kenBurnsScale applied in motion).
 * Kinds this compositor cannot draw (`fill`, `html`) are absent, and
 * hitting one throws ({@link drawLayer}) instead of skipping.
 * `drawTimeline` (C5) uses this same table for every kind except
 * `static-text`/`animated-text` — whose sequenced beat-selection and
 * crossfade ({@link drawBeat}) it calls directly at that layer's position —
 * so `logo` reaches {@link drawLogo} on both draw paths, anchored from a
 * layout `prepare` resolved ahead of time rather than one a prior drawer left
 * on the draw context (see {@link PreparedCreative.logoAnchorLayout}).
 * Module-private: the `@generated` barrels `export *` this file, so a named
 * export would leak `SKRSContext2D` (through {@link LayerDrawContext}) from
 * the public package surface; the structural tests spy the table through the
 * TS-private seam {@link NodeCanvasCompositor.layerDrawers}.
 */
const LAYER_DRAWERS: Readonly<Partial<Record<LayerKind, LayerDrawer>>> = {
  image: paintBackground,
  video: paintBackground,
  shade: paintShade,
  accent: paintAccent,
  "static-text": drawStaticText,
  "animated-text": drawStaticText,
  logo: drawLogo,
};

/**
 * NodeCanvasCompositor — CompositorPort adapter.
 *
 * Renders one creative with deterministic, treatment-driven layer stacking:
 *   1. background buffer
 *   2. contrast shade on the headline side (WCAG-legible copy)
 *   3. brand-colour accent band on the headline edge (on-brand + compliance anchor)
 *   4. campaign message
 *   5. brand logo, anchored opposite the headline
 *
 * `layout` mirrors the headline edge (bottom ↔ top) and the logo corner; `tone`
 * scales the shade opacity and font weight. The solid portion of the accent band
 * stays fully opaque in every tone, so the brand-density compliance floor holds.
 *
 * Copy is drawn in a bundled font (default "Inter") so headlines look identical
 * on every machine, independent of the reviewer's installed system fonts.
 *
 * The draw order is data (D121): `prepare` resolves the layer list (the brief's
 * `template.layers` when present — C3, every production request carries one —
 * else the canonical layers for its creative type, else the `image-text`
 * canonical list) and both draw paths iterate it — array position is z-order,
 * bottom first (D128). The legacy blit runs every layer through the
 * {@link LAYER_DRAWERS} table. The motion path (`drawTimeline`, C1/C5) iterates
 * the same list in the same order: ground kinds (and `logo`) go through the
 * same table, while the sequenced copy (`static-text`/`animated-text`) is
 * drawn at its list position through its own beat-selection and crossfade
 * ({@link drawBeat}) instead of the table's single-message drawer — so a
 * template that places the logo below the shade, or the copy above the accent
 * band, renders in that order on both paths (C5). A kind neither path can draw
 * throws the same way on both.
 *
 * Still path: {@link NodeCanvasCompositor.prepare} (I/O) →
 * {@link NodeCanvasCompositor.draw} at `t = 1` with no `motion`.
 */
export class NodeCanvasCompositor implements CompositorPort {
  /**
   * TS-private seam onto the module-level {@link LAYER_DRAWERS} table: the
   * table (and its `LayerDrawContext` parameter) must stay off the `@generated`
   * barrel, so the structural tests spy it through the index-signature escape —
   * `NodeCanvasCompositor["layerDrawers"]` — instead of an export.
   */
  private static readonly layerDrawers = LAYER_DRAWERS;

  constructor(private readonly fontFamily: string = "Inter") {
    registerBundledFonts();
  }

  /**
   * Paint a prepared creative onto `ctx`. With no `motion`, `t` is ignored and
   * the blit matches the still path. With `motion`, `t` ∈ [0, 1] drives that
   * kind; the solid accent and logo stay put. Logo placement (including the
   * headline-overlap snap) is resolved from the rest-pose headline box, so a
   * rising headline can never make the logo jump between edges mid-clip.
   *
   * A prepared timeline (D1/D2) selects the beat by `copyT ?? t`: the video
   * poster passes a key-beat clock so it shows exactly the key beat at rest (D7),
   * while `headline-rise` still advances on `t` per beat's local progress. Laying
   * out and resolving happened once in `prepare` (D6/D9) — this method only
   * paints (M4). Without a timeline, `draw` delegates to the frozen legacy path
   * ([`drawLegacy`]) so stills and legacy motion bytes stay identical (D10).
   *
   * The text effect rides a third clock, `effectT` (same optional-param shape as
   * `copyT`). Still and poster callers pass `1` so the still is the effect's
   * completed state (H4) even when the pose clock is `restT = 0` (`ken-burns-out`).
   * Clip frames omit it: the legacy path falls back to `t`, the timeline path
   * keeps each beat's own local progress.
   */
  static draw(
    ctx: SKRSContext2D,
    prepared: PreparedCreative,
    t: number,
    motion?: MotionKind,
    copyT?: number,
    effectT?: number,
  ): void {
    if (
      prepared.timeline !== undefined &&
      prepared.beatLayouts !== undefined &&
      prepared.anchorLayout !== undefined
    ) {
      const scenes: BeatScenes = {
        resolved: prepared.timeline,
        beats: prepared.beatLayouts,
      };
      drawTimeline(ctx, prepared, scenes, t, motion, copyT ?? t, effectT);
      return;
    }
    NodeCanvasCompositor.drawLegacy(ctx, prepared, t, motion, effectT ?? t);
  }

  /**
   * The legacy single-message path (D10). **Amended 2026-09-01 (T5, recorded
   * here explicitly per the plan's D10 discussion):** the body now reads the
   * creative style off `PreparedCreative` — `textAlign` and `letterSpacing`
   * (plus the left/right x-position math against the safe area) come from the
   * prepared style instead of the literals `center` / unset. The freeze's real
   * invariant was never "this exact source"; it is **byte-identity for
   * style-less briefs**: a `PreparedCreative` whose resolved style is the
   * defaults object must render the exact bytes this body rendered before the
   * amendment. That invariant is proven by the platform goldens and the
   * byte-identity suite, which MUST pass unchanged — the defaults flow through
   * the same expressions with the same values (align `center` → the same
   * `centerX`; letterSpacing `0` → a no-op `"0px"`). New behaviour beyond the
   * style fields still belongs in the timeline branch of
   * {@link NodeCanvasCompositor.draw}. **Amended 2026-09-02:** the signature
   * gained an optional `effectT` (default the motion `t`) so the poster can
   * settle the text effect independently of a `restT = 0` pose; a style-less
   * brief is byte-identical either way (identity pose, D10). **Amended
   * 2026-09-08 (L2a, D121):** the body is now a dispatch — it iterates
   * `prepared.layers` (resolved in `prepare`, D128) through the
   * {@link LAYER_DRAWERS} table, whose entries are this body's former five
   * blocks extracted verbatim. The previous body's band-height literals
   * mirrored `CREATIVE_GEOMETRY` values; the shared accent drawer now reads
   * the leaf directly (same numbers — the goldens pin the bytes).
   */
  static drawLegacy(
    ctx: SKRSContext2D,
    prepared: PreparedCreative,
    t: number,
    motion?: MotionKind,
    effectT: number = t,
  ): void {
    const c: LayerDrawContext = {
      ctx,
      prepared,
      motion,
      eased: motion === undefined ? 1 : easeOutCubic(t),
      effectT,
    };
    // The draw order is the layer list (D121/D128): array position is z-order,
    // bottom first. A kind with no table entry throws — it never skips.
    for (const layer of prepared.layers) {
      drawLayer(layer.kind, c);
    }
  }

  /**
   * Load background + logo and capture everything {@link NodeCanvasCompositor.draw}
   * needs. When the request carries `copy.timeline` *and* `durationSec`, the whole
   * beat sequence is resolved and fitted once here (D6/D9) — a still (no
   * durationSec) or a timeline-free request never resolves a timeline (D10).
   */
  static async prepare(
    request: CompositeRequest & {
      readonly durationSec?: number;
      readonly timeline?: CopyTimeline;
      /**
       * Direct-caller escape hatch: with no `template`, the canonical layers
       * for this creative type. Production never passes it — `request.template`
       * (D120/D123, C3) is what every real caller carries, via `parseBrief`.
       */
      readonly creativeType?: CreativeType;
    },
    fontFamily: string = "Inter",
  ): Promise<PreparedCreative> {
    const canvas = request.canvas;
    const resolved = resolveCanvas(canvas);
    const width = request.pixelSize?.width ?? resolved.width;
    const height = request.pixelSize?.height ?? resolved.height;
    const top = request.layout === "headline-top";
    // The anchor axis (T4): absent → derived from layout, the pre-axis
    // behaviour bit for bit (D54 — the goldens pin both derived paths).
    const anchor: AnchorKind = request.anchor ?? (top ? "top" : "bottom");
    const subtle = request.tone === "subtle";
    const shadeAlpha = subtle
      ? CREATIVE_GEOMETRY.shadeAlpha.subtle
      : CREATIVE_GEOMETRY.shadeAlpha.bold;
    const fontWeight = subtle ? "500" : "bold";
    // The style block (T5): resolved once here, every absent field falling to
    // today's literal (D54) and the weight to the tone-derived one (D60). The
    // brief's family — a parse-validated allowlist member — overrides the
    // deployment default; with no style block the deployment default stands.
    const style = resolveStyle(request.style, fontWeight, fontFamily);
    const insets = normalizeSafeInsets(request.safeInsets, width, height);

    const background = await loadImage(Buffer.from(request.background));

    // The resolved draw order (D121/D128) — resolved here so `logoApplied`
    // below can be derived from what the draw will actually paint.
    const layers = resolveLayerList(request.template, request.creativeType);

    // Whether the logo applies is a brand-compliance signal the use case records
    // on the asset. The path is brief-supplied (untrusted), so it's resolved
    // through resolveAssetPath.
    let logo: PreparedCreative["logo"];
    let logoLoaded = false;
    const logoPath = resolveAssetPath(request.logoPath);
    if (logoPath) {
      try {
        const image = await loadImage(await readFile(logoPath));
        const target = scaleBasis(canvas, width, height) * CREATIVE_GEOMETRY.logoWidthFraction;
        const scale = target / image.width;
        const logoH = image.height * scale;
        const margin = widthTermBasis(canvas, width, height) * CREATIVE_GEOMETRY.logoMarginFraction;
        // Inset offset lives here so every still — and later every motion frame —
        // reuses the same logo geometry (`t` does not move the logo). Same additive
        // form as the pre-inset anchors so a no-op clamp stays bit-identical.
        const rawX = (top ? margin : width - target - margin) + (top ? insets.left : -insets.right);
        const rawY = (top ? height - logoH - margin : margin) + (top ? -insets.bottom : insets.top);
        const lx = clampInRange(rawX, insets.left, width - insets.right - target);
        const ly = clampInRange(rawY, insets.top, height - insets.bottom - logoH);
        logo = { image, x: lx, y: ly, width: target, height: logoH };
        logoLoaded = true;
      } catch (error) {
        // A missing logo is optional — skip cleanly. A present-but-unreadable or
        // corrupt one is likely a mistake, so surface it (observable degradation)
        // without aborting the run: logoApplied stays false and the compliance
        // report flags it.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          const reason = error instanceof Error ? error.message : String(error);
          console.warn(`[NodeCanvasCompositor] logo at ${logoPath} could not be applied: ${reason}`);
        }
      }
    }

    // `logoApplied` reports what was DRAWN, not what loaded (F2): the logo
    // layer is optional, so a template that omits it paints no logo pixels
    // even with the file loaded — and the load alone must not credit
    // brand-compliance for a logo that never rendered. "Loaded AND the
    // resolved list carries a `logo` layer" is exactly the logo drawer
    // painting; computed here, where the list is resolved, never by mutating
    // shared state mid-draw.
    const logoApplied = logoLoaded && layers.some((layer) => layer.kind === "logo");

    const base: Omit<
      PreparedCreative,
      "timeline" | "beatLayouts" | "anchorLayout" | "logoAnchorLayout"
    > = {
      canvas,
      width,
      height,
      top,
      anchor,
      shadeAlpha,
      fontWeight: style.fontWeight,
      fontFamily: style.fontFamily,
      style,
      textEffect: style.textEffect,
      message: request.message,
      brandColor: request.brandColor,
      background,
      logo,
      logoApplied,
      insets,
      layers,
    };

    // What the logo snaps to (C5), resolved here independent of where `logo`
    // sits in `layers` — see PreparedCreative.logoAnchorLayout. `undefined`
    // when the resolved list carries no text-kind layer at all: there is
    // nothing for the logo to snap against.
    const hasTextLayer = layers.some(
      (layer) => layer.kind === "static-text" || layer.kind === "animated-text",
    );

    // Sequenced copy: resolve windows and fit every beat at one common type size
    // (D6) right here, so `draw` (every frame, the poster, and every sample) pays
    // nothing but the blit. Still requests have no durationSec and no windows.
    if (request.timeline !== undefined && request.durationSec !== undefined) {
      const beatFields = resolveBeatLayouts(base, request.timeline, request.durationSec);
      return {
        ...base,
        ...beatFields,
        logoAnchorLayout: hasTextLayer ? beatFields.anchorLayout : undefined,
      };
    }
    // The still path's own rest layout, measured on a throwaway context —
    // the same technique `resolveBeatLayouts` uses for the timeline path, and
    // provably the same numbers `drawStaticText` measures on the real blit
    // context (SKIA metrics don't depend on the canvas's backing size).
    const logoAnchorLayout = hasTextLayer
      ? layoutHeadline(createCanvas(1, 1).getContext("2d"), base)
      : undefined;
    return { ...base, logoAnchorLayout };
  }

  async compositeAsset(request: CompositeRequest): Promise<CompositeResult> {
    const prepared = await NodeCanvasCompositor.prepare(request, this.fontFamily);
    const canvas = createCanvas(prepared.width, prepared.height);
    const ctx = canvas.getContext("2d");
    // Still: pose at t = 1, effect clock settled (H4). The two clocks agree
    // here; passing the effect clock explicitly matches the poster call-site.
    NodeCanvasCompositor.draw(ctx, prepared, 1, undefined, undefined, 1);
    return { image: canvas.toBuffer("image/png"), logoApplied: prepared.logoApplied };
  }
}

const ZERO_INSETS: SafeInsets = { top: 0, right: 0, bottom: 0, left: 0 };
const SIDES = ["top", "right", "bottom", "left"] as const;
const ELLIPSIS = "…";
/** Zoom amount applied away from the ken-burns rest pose so scale(restT) === 1. */
const KEN_BURNS_ZOOM = 0.08;

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

/** The copy layer's whole-block pose at a moment: the text effect's output (T6). */
interface TextEffectPose {
  readonly dx: number;
  readonly dy: number;
  readonly alpha: number;
  readonly scale: number;
}

const TEXT_EFFECT_REST: TextEffectPose = { dx: 0, dy: 0, alpha: 1, scale: 1 };

/**
 * The text effect's pose at a beat-local progress (T6): a whole-block
 * alpha/translate/scale on the COPY layer only, eased with the motion kinds'
 * own `easeOutCubic` over the leaf's entrance window (one source, both draw
 * paths read it). Rest pose (H4): at or past the window's end — in particular
 * at `t = 1` and on the still/poster path — every kind is the identity pose,
 * so the frame is byte-identical to the same brief with no effect (D54).
 */
function textEffectPose(
  kind: TextEffectKind | undefined,
  local: number,
  spec: CanvasSpec,
  width: number,
  height: number,
): TextEffectPose {
  if (kind === undefined) return TEXT_EFFECT_REST;
  const settled = easeOutCubic(clamp01(local / CREATIVE_GEOMETRY.textEffect.entranceFraction));
  const { riseOffsetFraction, slideOffsetFraction, scaleAmplitude } = CREATIVE_GEOMETRY.textEffect;
  switch (kind) {
    case "fade-in":
      return { ...TEXT_EFFECT_REST, alpha: settled };
    case "rise-in":
      return { ...TEXT_EFFECT_REST, dy: (1 - settled) * riseOffsetFraction * height };
    case "slide-in":
      return { ...TEXT_EFFECT_REST, dx: (1 - settled) * slideOffsetFraction * scaleBasis(spec, width, height) };
    case "scale-in":
      return { ...TEXT_EFFECT_REST, scale: 1 - (1 - settled) * scaleAmplitude };
  }
}

/**
 * Open the copy layer's save block for a composed pose, when one is needed.
 * The text effect COMPOSES with the motion kind's rise (T6): translations add,
 * alphas multiply — `headline-rise` keeps its layer and the effect drives only
 * the copy entrance. `scale-in` scales about the block's own centre, so a
 * growing headline grows where it rests. Identity pose touches no ctx state:
 * the style-less (and rest-pose) frame renders byte-identically (D54). Returns
 * whether a block was opened — the caller closes it with `ctx.restore()`.
 */
function openTextPose(ctx: SKRSContext2D, alpha: number, dx: number, dy: number, scale: number, layout: HeadlineLayout): boolean {
  if (dx === 0 && dy === 0 && alpha === 1 && scale === 1) return false;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(dx, dy);
  if (scale !== 1) {
    const cx = layout.box.x + layout.box.width / 2;
    const cy = layout.box.y + layout.box.height / 2;
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -cy);
  }
  return true;
}

/** Identity at restT: in eases 1.08 → 1.00, out eases 1.00 → 1.08. */
function kenBurnsScale(motion: MotionKind | undefined, eased: number): number {
  if (motion === "ken-burns-in") return 1 + KEN_BURNS_ZOOM * (1 - eased);
  if (motion === "ken-burns-out") return 1 + KEN_BURNS_ZOOM * eased;
  return 1;
}

function normalizeSafeInsets(
  raw: CompositeRequest["safeInsets"],
  width: number,
  height: number,
): SafeInsets {
  if (raw === undefined) return ZERO_INSETS;
  const insets: SafeInsets = { top: raw.top, right: raw.right, bottom: raw.bottom, left: raw.left };
  for (const side of SIDES) {
    const value = insets[side];
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`safeInsets.${side} must be a finite number ≥ 0`);
    }
  }
  if (insets.top + insets.bottom >= height) {
    throw new Error("safeInsets.top + safeInsets.bottom must be < height");
  }
  if (insets.left + insets.right >= width) {
    throw new Error("safeInsets.left + safeInsets.right must be < width");
  }
  return insets;
}

function clampInRange(raw: number, min: number, max: number): number {
  return max < min ? min : Math.min(Math.max(raw, min), max);
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function boxesOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function ellipsize(ctx: SKRSContext2D, text: string, maxWidth: number): string {
  let base = text;
  while (base.length > 0 && ctx.measureText(`${base}${ELLIPSIS}`).width > maxWidth) {
    base = base.slice(0, -1);
  }
  return base.length > 0 ? `${base}${ELLIPSIS}` : ELLIPSIS;
}

interface HeadlineLayout {
  readonly lines: readonly string[];
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly firstY: number;
  readonly centerX: number;
  readonly box: Box;
}

/**
 * The prepared-fields the layout math reads, so fitting works on the real blit
 * context and on the throwaway measure context alike — and so the timeline
 * path (which measures on the 1×1 context, F5a) inherits the anchor the same
 * way the still path does.
 */
type LayoutSource = Pick<
  PreparedCreative,
  "canvas" | "width" | "height" | "top" | "anchor" | "fontWeight" | "fontFamily" | "style" | "insets"
>;

/**
 * The block's first baseline for the anchor: `top` pins the block's top edge
 * at the leaf's top fraction, `bottom` pins its last baseline at the bottom
 * fraction, `middle` centres the wrapped block (span + type size) at the
 * leaf's middle fraction of the SAFE-area height, so insets shift it. The
 * top/bottom expressions are the frozen legacy arithmetic with its literals
 * replaced by the leaf's byte-identical values — an absent axis (derived
 * anchor) keeps today's numbers exactly (D54).
 */
function anchorFirstY(p: LayoutSource, span: number, fontSize: number): number {
  if (p.anchor === "middle") {
    const safeHeight = p.height - p.insets.top - p.insets.bottom;
    return (
      p.insets.top + safeHeight * CREATIVE_GEOMETRY.headlineAnchor.middle - (span + fontSize) / 2 + fontSize
    );
  }
  return p.anchor === "top"
    ? p.height * CREATIVE_GEOMETRY.headlineAnchor.top + fontSize + p.insets.top
    : p.height - p.height * CREATIVE_GEOMETRY.headlineAnchor.bottom - span - p.insets.bottom;
}

/**
 * The x the text layer draws at, per the prepared style's alignment (T5/C2),
 * against the safe area: `left` flush to the left inset edge, `right` flush to
 * the right inset edge, `center` the layout's centre — which for the default
 * style is exactly the pre-style literal (D54, goldens-pinned).
 */
function headlineTextX(p: LayoutSource, centerX: number): number {
  switch (p.style.align) {
    case "left":
      return p.insets.left;
    case "right":
      return p.width - p.insets.right;
    default:
      return centerX;
  }
}

/**
 * Lay a text out at its natural (autofit) type size — the legacy path's only
 * layout, and the per-beat first pass behind the D6 common size.
 */
function fitText(ctx: SKRSContext2D, p: LayoutSource, text: string): HeadlineLayout {
  const originalFontSize = Math.round(scaleBasis(p.canvas, p.width, p.height) * p.style.sizeScale);
  const floor = Math.round(originalFontSize * CREATIVE_GEOMETRY.headlineTypeFloorFraction);

  let fontSize = originalFontSize;
  let attempt = layoutAt(ctx, p, text, fontSize);
  while (!attempt.fits && fontSize > floor) {
    fontSize = Math.max(floor, fontSize - 4);
    attempt = layoutAt(ctx, p, text, fontSize);
  }
  return settleLayout(ctx, p, attempt);
}

/**
 * Lay a text out at a caller-chosen type size — the D6 common size decided once
 * in `prepare`, never the autofit loop (M4). `draw` no longer re-wraps.
 */
function layoutFixed(ctx: SKRSContext2D, p: LayoutSource, text: string, fontSize: number): HeadlineLayout {
  return settleLayout(ctx, p, layoutAt(ctx, p, text, fontSize));
}

/** The exact legacy fitting arithmetic at a single type size. */
function layoutAt(ctx: SKRSContext2D, p: LayoutSource, text: string, fontSize: number): LayoutAttempt {
  const wrapBasis = widthTermBasis(p.canvas, p.width, p.height);
  const innerWidth = wrapBasis - p.insets.left - p.insets.right;
  const wrapWidth = innerWidth * 0.85;
  ctx.font = `${p.fontWeight} ${fontSize}px ${p.fontFamily}, sans-serif`;
  // Letter spacing (T5) is a ctx-state control: wrapText must measure with it,
  // or the fit math and the blit disagree. px = em × fontSize; the default is
  // 0px, a no-op Skia accepts (the goldens pin it).
  ctx.letterSpacing = `${p.style.letterSpacing * fontSize}px`;
  const lines = wrapText(ctx, text, wrapWidth);
  const lineHeight = fontSize * p.style.lineHeight;
  const minFirst = p.insets.top + fontSize;
  const maxLast = p.height - p.insets.bottom;
  const span = (lines.length - 1) * lineHeight;
  const fits = minFirst + span <= maxLast;
  let firstY = anchorFirstY(p, span, fontSize);
  if (fits) {
    firstY = Math.min(Math.max(firstY, minFirst), maxLast - span);
  }
  return { lines, fontSize, lineHeight, firstY, fits, minFirst, maxLast, span, wrapWidth };
}

interface LayoutAttempt {
  readonly lines: readonly string[];
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly firstY: number;
  readonly fits: boolean;
  readonly minFirst: number;
  readonly maxLast: number;
  readonly span: number;
  readonly wrapWidth: number;
}

/**
 * The x the headline BLOCK's wrap box occupies, per the prepared style's
 * alignment (T5 finding 1) — the box form of {@link headlineTextX}: `left`
 * flush to the left inset edge, `right` ending at the right inset edge,
 * `center` the pre-style centred box (byte-identical, goldens-pinned). The
 * logo's overlap snap must see the block where it actually draws — a
 * left-aligned headline occupies [insets.left, insets.left + width], not the
 * centred range — so the box's x derives from the same rule the draw x does.
 * Exported pure (the `resolveOverlappingLogoY` mould on the preview) so the
 * rule is unit-testable without a canvas.
 */
export function headlineBoxX(p: LayoutSource, centerX: number, boxWidth: number): number {
  switch (p.style.align) {
    case "left":
      return p.insets.left;
    case "right":
      return p.width - p.insets.right - boxWidth;
    default:
      return centerX - boxWidth / 2;
  }
}

function settleLayout(ctx: SKRSContext2D, p: LayoutSource, attempt: LayoutAttempt): HeadlineLayout {
  if (!attempt.fits) {
    const maxLines = Math.max(1, Math.floor((attempt.maxLast - attempt.minFirst) / attempt.lineHeight) + 1);
    let lines = [...attempt.lines];
    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      lines[lines.length - 1] = ellipsize(ctx, lines[lines.length - 1], attempt.wrapWidth);
    }
    const span = (lines.length - 1) * attempt.lineHeight;
    let firstY = anchorFirstY(p, span, attempt.fontSize);
    firstY = Math.min(Math.max(firstY, attempt.minFirst), attempt.maxLast - span);
    attempt = { ...attempt, lines, firstY, span, fits: true };
  }
  const centerX = p.insets.left + (p.width - p.insets.left - p.insets.right) / 2;
  return {
    lines: attempt.lines,
    fontSize: attempt.fontSize,
    lineHeight: attempt.lineHeight,
    firstY: attempt.firstY,
    centerX,
    box: {
      x: headlineBoxX(p, centerX, attempt.wrapWidth),
      y: attempt.firstY - attempt.fontSize,
      width: attempt.wrapWidth,
      height: attempt.span + attempt.fontSize,
    },
  };
}

function layoutHeadline(ctx: SKRSContext2D, prepared: PreparedCreative): HeadlineLayout {
  return fitText(ctx, prepared, prepared.message);
}

function flushLogoY(edge: "top" | "bottom", height: number, logoH: number, insets: SafeInsets): number {
  return edge === "top" ? insets.top : height - insets.bottom - logoH;
}

function resolveOverlappingLogoY(
  prepared: PreparedCreative,
  headlineBox: Box,
  logoW: number,
  logoH: number,
  logoX: number,
): number {
  const preferred: "top" | "bottom" = prepared.top ? "bottom" : "top";
  const preferredY = flushLogoY(preferred, prepared.height, logoH, prepared.insets);
  if (!boxesOverlap(headlineBox, { x: logoX, y: preferredY, width: logoW, height: logoH })) {
    return preferredY;
  }
  const other: "top" | "bottom" = preferred === "top" ? "bottom" : "top";
  const otherY = flushLogoY(other, prepared.height, logoH, prepared.insets);
  if (!boxesOverlap(headlineBox, { x: logoX, y: otherY, width: logoW, height: logoH })) {
    return otherY;
  }
  return preferredY;
}

/**
 * Everything the sequenced-copy draw needs once the request resolved a
 * timeline (D6/D9). The logo's anchor is not here (C5) — it reads
 * `prepared.logoAnchorLayout` directly, so it stays available at the logo's
 * list position whether or not copy has drawn yet.
 */
interface BeatScenes {
  readonly resolved: readonly ResolvedBeat[];
  readonly beats: ReadonlyMap<string, HeadlineLayout>;
}

/**
 * Resolve a timeline's beat windows and fit every distinct beat text at one
 * common type size (D6): each text's natural fit is measured once, the sequence
 * takes the smallest size, and every text is re-laid at it. Layouts are keyed by
 * text, so a repeated beat shares its layout.
 */
function resolveBeatLayouts(
  prepared: PreparedCreative,
  timeline: CopyTimeline,
  durationSec: number,
): {
  readonly timeline: readonly ResolvedBeat[];
  readonly beatLayouts: ReadonlyMap<string, HeadlineLayout>;
  readonly anchorLayout: HeadlineLayout;
} {
  const resolved = resolveTimeline(timeline, durationSec);
  if (resolved.length === 0) {
    throw new Error(
      "NodeCanvasCompositor: cannot fit an empty copy.timeline; reject it with timelineProblem before rendering.",
    );
  }
  // A throwaway measure context — wrapText needs a context for measureText, and
  // SKIA metrics are independent of the canvas backing size.
  const ctx = createCanvas(1, 1).getContext("2d");
  const texts = [...new Set(resolved.map((beat) => beat.text))];
  const naturalSizes = texts.map((text) => fitText(ctx, prepared, text).fontSize);
  const commonSize = Math.min(...naturalSizes);
  // `keyBeat` is a 1-based index the domain bounds and the parser rejects out of range, so
  // a malformed one cannot reach here through the pipeline. A direct adapter call can still
  // carry one, and indexing past the end would throw a bare TypeError from deep inside the
  // canvas work — a failure wearing the wrong name, several frames from its cause. Say what
  // is actually wrong instead, as `beatAt` does for an empty timeline.
  const anchorBeat = timeline.beats[timeline.keyBeat - 1];
  if (anchorBeat === undefined) {
    throw new Error(
      `copy.timeline.keyBeat is ${timeline.keyBeat}, outside [1, ${timeline.beats.length}]; ` +
        "validate with timelineProblem before compositing.",
    );
  }
  const anchorText = anchorBeat.text;
  const beatLayouts = new Map<string, HeadlineLayout>();
  let anchorLayout!: HeadlineLayout;
  for (const text of texts) {
    const layout = layoutFixed(ctx, prepared, text, commonSize);
    beatLayouts.set(text, layout);
    if (text === anchorText) {
      anchorLayout = layout;
    }
  }
  return { timeline: resolved, beatLayouts, anchorLayout };
}

/**
 * The motion path (C1/C5). Every layer draws at its position in
 * `prepared.layers` — the same resolved list `drawLegacy` iterates — so a
 * template's order is honoured whole, not just among the ground kinds. Ground
 * kinds and `logo` run through the same {@link LAYER_DRAWERS} table
 * `drawLegacy` uses (one copy of each layer's code serves both paths); the
 * sequenced copy (`static-text`/`animated-text`) is drawn at its list
 * position through {@link drawSequencedCopy} instead of the table's
 * single-message drawer, because its "how" is beat selection and crossfade,
 * not a fixed message (copy is chosen by `copyT` — the poster passes the key
 * beat's mid-time, D7 — and `headline-rise` advances per beat on the pose
 * clock `t`, each beat rising on its own local progress). A kind neither path
 * can draw (`html`, `fill`) throws the same "no drawer" error here as it does
 * on the legacy blit. `effectT` is a value no ground drawer reads
 * (`effectT ?? t` matches `draw()`'s clock shape).
 *
 * The logo's overlap snap reads `prepared.logoAnchorLayout` (C5) — resolved
 * once in `prepare`, independent of where `logo` sits in the list — so it
 * keeps its key-beat anchor (D7) whether it is drawn before or after the
 * copy. A resolved list with no text-kind layer at all leaves
 * `logoAnchorLayout` undefined and {@link drawLogo} throws, the same refusal
 * the still path makes for the same reason.
 */
function drawTimeline(
  ctx: SKRSContext2D,
  prepared: PreparedCreative,
  scenes: BeatScenes,
  t: number,
  motion: MotionKind | undefined,
  copyT: number,
  effectT?: number,
): void {
  const eased = motion === undefined ? 1 : easeOutCubic(t);
  const c: LayerDrawContext = { ctx, prepared, motion, eased, effectT: effectT ?? t };
  let copyDrawn = false;
  for (const layer of prepared.layers) {
    if (layer.kind === "static-text" || layer.kind === "animated-text") {
      // A creative type's shared budget caps text-kind layers at one (D124);
      // this guard is defensive, not load-bearing — never draws the beat twice.
      if (copyDrawn) continue;
      drawSequencedCopy(ctx, prepared, scenes, copyT, t, motion, effectT);
      copyDrawn = true;
      continue;
    }
    drawLayer(layer.kind, c);
  }
}

/**
 * Layer 4 — sequenced copy: the beat is selected by `copyT`, crossfaded with
 * any incoming beat, and (for headline-rise) eased on its own local progress.
 * Extracted verbatim from `drawTimeline`'s former fixed post-loop call (C5) —
 * only WHEN this runs changed (at the copy layer's list position), never HOW.
 */
function drawSequencedCopy(
  ctx: SKRSContext2D,
  prepared: PreparedCreative,
  scenes: BeatScenes,
  copyT: number,
  t: number,
  motion: MotionKind | undefined,
  effectT: number | undefined,
): void {
  const pair = beatAt(scenes.resolved, copyT);
  const rise = motion === "headline-rise";
  if (pair.mix > 0 && pair.incoming !== undefined) {
    drawBeat(ctx, prepared, scenes, pair.current, 1 - pair.mix, t, rise, effectT);
    drawBeat(ctx, prepared, scenes, pair.incoming, pair.mix, t, rise, effectT);
  } else {
    drawBeat(ctx, prepared, scenes, pair.current, 1, t, rise, effectT);
  }
}

/** Paint one beat's copy at the given layer opacity (`1 - mix` / `mix` during a crossfade). */
function drawBeat(
  ctx: SKRSContext2D,
  prepared: PreparedCreative,
  scenes: BeatScenes,
  beat: ResolvedBeat,
  layerAlpha: number,
  t: number,
  rise: boolean,
  effectT?: number,
): void {
  const layout = scenes.beats.get(beat.text);
  if (layout === undefined) {
    throw new Error(`NodeCanvasCompositor: no fitted layout for beat "${beat.text}".`);
  }
  // Local progress inside the beat's own window, so headline-rise resets with
  // each beat (Q1) while the global pose clock keeps the ground layers continuous.
  const local = clamp01((t - beat.startT) / (beat.endT - beat.startT));
  const eased = rise ? easeOutCubic(local) : 1;
  const riseDy = rise ? (1 - eased) * 0.12 * prepared.height : 0;
  const riseAlpha = rise ? eased : 1;
  // The text effect (T6) plays on each beat's OWN local progress — the same
  // clock the rise rides — unless the caller passed a settled effect clock
  // (the poster: 1, H4). Clip frames omit it, so the beat-local entrance
  // still plays. The beat's exit mix (`layerAlpha`) keeps its behaviour.
  // Undefined effect → the identity pose → the pre-effect bytes (D54).
  const fx = textEffectPose(prepared.textEffect, effectT ?? local, prepared.canvas, prepared.width, prepared.height);
  const dy = riseDy + fx.dy;
  const alpha = riseAlpha * fx.alpha;
  const opacity = alpha * layerAlpha;
  ctx.fillStyle = "#ffffff";
  // F5a: this path measures on a throwaway 1×1 context and re-sets ctx.font
  // below, so every ctx-state control is (re-)stated HERE, not inherited — a
  // control applied only at the still would silently drop from the video blit.
  ctx.textAlign = prepared.style.align;
  ctx.textBaseline = "alphabetic";
  ctx.letterSpacing = `${prepared.style.letterSpacing * layout.fontSize}px`;
  ctx.font = `${prepared.fontWeight} ${layout.fontSize}px ${prepared.fontFamily}, sans-serif`;
  const posed = openTextPose(ctx, opacity, fx.dx, dy, fx.scale, layout);
  let y = layout.firstY;
  for (const line of layout.lines) {
    ctx.fillText(line, headlineTextX(prepared, layout.centerX), y);
    y += layout.lineHeight;
  }
  if (posed) {
    ctx.restore();
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** The image layer — the background buffer; ken-burns zooms this layer only (D121). */
function paintBackground(c: LayerDrawContext): void {
  const { ctx, prepared, motion, eased } = c;
  const { width, height } = prepared;
  const zoom = kenBurnsScale(motion, eased);
  if (zoom === 1) {
    ctx.drawImage(prepared.background, 0, 0, width, height);
  } else {
    ctx.save();
    ctx.translate(width / 2, height / 2);
    ctx.scale(zoom, zoom);
    ctx.translate(-width / 2, -height / 2);
    ctx.drawImage(prepared.background, 0, 0, width, height);
    ctx.restore();
  }
}

/** The shade layer — contrast shade, darkest at the headline edge (D121). */
function paintShade(c: LayerDrawContext): void {
  const { ctx, prepared } = c;
  const { width, height, top, shadeAlpha } = prepared;
  const shade = top
    ? ctx.createLinearGradient(0, height * 0.55, 0, 0)
    : ctx.createLinearGradient(0, height * 0.45, 0, height);
  shade.addColorStop(0, "rgba(0, 0, 0, 0)");
  shade.addColorStop(1, `rgba(0, 0, 0, ${shadeAlpha})`);
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, width, height);
}

/**
 * The accent layer (D121) — a brand-colour solid base flush to the headline
 * edge plus a soft fade into the image; the fade's extent is scaled by the
 * motion `wipe`. Solid stays opaque in every tone, and this band — not the
 * logo — is what guarantees the brand-density compliance floor. The band
 * heights read `CREATIVE_GEOMETRY` (the legacy body's literals mirrored these
 * exact values; the goldens pin the bytes).
 */
function paintAccent(c: LayerDrawContext): void {
  const { ctx, prepared, motion, eased } = c;
  const { width, height, top } = prepared;
  const [ar, ag, ab] = hexToRgb(prepared.brandColor);
  const solidH = height * CREATIVE_GEOMETRY.accentSolidHeightFraction;
  const fadeH = height * CREATIVE_GEOMETRY.accentFadeHeightFraction;
  const wipe = motion === "accent-wipe" ? eased : 1;
  ctx.fillStyle = `rgb(${ar}, ${ag}, ${ab})`;
  if (top) {
    ctx.fillRect(0, 0, width, solidH);
    if (wipe > 0) {
      const fade = ctx.createLinearGradient(0, solidH, 0, solidH + fadeH);
      fade.addColorStop(0, `rgb(${ar}, ${ag}, ${ab})`);
      fade.addColorStop(1, `rgba(${ar}, ${ag}, ${ab}, 0)`);
      ctx.fillStyle = fade;
      ctx.fillRect(0, solidH, width, fadeH * wipe);
    }
  } else {
    ctx.fillRect(0, height - solidH, width, solidH);
    if (wipe > 0) {
      const fade = ctx.createLinearGradient(0, height - solidH - fadeH, 0, height - solidH);
      fade.addColorStop(0, `rgba(${ar}, ${ag}, ${ab}, 0)`);
      fade.addColorStop(1, `rgb(${ar}, ${ag}, ${ab})`);
      ctx.fillStyle = fade;
      ctx.fillRect(0, height - solidH - fadeH * wipe, width, fadeH * wipe);
    }
  }
}

/**
 * The static-text layer — the legacy copy block, extracted verbatim (D121):
 * fitted on the real blit context, so the layout pass's ctx.font state feeds
 * the blit. The logo's overlap snap no longer reads this drawer's output off
 * the context (C5) — it reads `prepared.logoAnchorLayout`, resolved ahead of
 * time in `prepare` — so this drawer's only job is painting.
 */
function drawStaticText(c: LayerDrawContext): void {
  const { ctx, prepared, motion, eased, effectT } = c;
  const { width, height } = prepared;
  // Layer 4 — campaign copy, wrapped to the inset-reduced width and placed
  // in the inset rectangle per the prepared style's alignment (D10 amendment,
  // T5). wrapText uses this ctx so metrics match the blit.
  const headline = layoutHeadline(ctx, prepared);
  const rise = motion === "headline-rise";
  const riseDy = rise ? (1 - eased) * 0.12 * height : 0;
  const riseAlpha = rise ? eased : 1;
  // The text effect (T6) rides the effect clock, not the motion pose clock,
  // and COMPOSES with the motion kind: translations add, alphas multiply.
  // Still/poster callers pass 1 (H4) so a ken-burns-out rest (t = 0) never
  // samples the entrance; clip frames omit it and `t` is used. Undefined
  // effect → the identity pose → exactly the pre-effect bytes (D54).
  const fx = textEffectPose(prepared.textEffect, effectT, prepared.canvas, width, height);
  const dy = riseDy + fx.dy;
  const alpha = riseAlpha * fx.alpha;
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = prepared.style.align;
  ctx.textBaseline = "alphabetic";
  // A ctx-state control (F5a): re-stated at the blit, not inherited from the
  // layout pass — the default 0px is a no-op, the goldens pin it.
  ctx.letterSpacing = `${prepared.style.letterSpacing * headline.fontSize}px`;
  const posed = openTextPose(ctx, alpha, fx.dx, dy, fx.scale, headline);
  let y = headline.firstY;
  for (const line of headline.lines) {
    ctx.fillText(line, headlineTextX(prepared, headline.centerX), y);
    y += headline.lineHeight;
  }
  if (posed) {
    ctx.restore();
  }
}

/**
 * The logo layer — the legacy logo block (D121), its anchor source changed
 * for C5: the overlap snap now reads `prepared.logoAnchorLayout`, resolved in
 * `prepare` independent of draw order, instead of a layout a prior drawer
 * left on the shared context. That is what lets this same drawer serve both
 * paths — legacy (whole-list order) and timeline (C5, via `drawTimeline`'s
 * per-position dispatch) — for a template that places `logo` before its
 * text-kind layer, or with no text-kind layer drawn in between. A resolved
 * layer list with no text-kind layer at all leaves `logoAnchorLayout`
 * undefined: there is nothing for the logo to snap to, and this throws rather
 * than guessing an anchor.
 */
function drawLogo(c: LayerDrawContext): void {
  const { ctx, prepared } = c;
  // Layer 5 — brand logo, anchored opposite the headline (top-right for a bottom
  // headline, bottom-left for a top headline). Inset offset was captured in
  // prepare; if the rest-pose headline block overlaps it, snap to an inset edge.
  // The rest-pose box (not the translated one) keeps the logo static across `t`.
  if (prepared.logo) {
    const anchor = prepared.logoAnchorLayout;
    if (anchor === undefined) {
      throw new Error(
        "NodeCanvasCompositor: the logo layer snaps to the text block, but there is no text layer in the template at all",
      );
    }
    const { image, x, width: lw, height: lh } = prepared.logo;
    let ly = prepared.logo.y;
    const logoBox = { x, y: ly, width: lw, height: lh };
    if (boxesOverlap(anchor.box, logoBox)) {
      ly = resolveOverlappingLogoY(prepared, anchor.box, lw, lh, x);
    }
    ctx.drawImage(image, x, ly, lw, lh);
  }
}

/**
 * Resolve the draw order once in `prepare` (D121): the request's `template`
 * when the caller passes the L1b brief template, else the canonical template
 * for its creative type, else the `image-text` canonical list. A brief parsed
 * through `parseBrief` always carries a template — both fallbacks are for
 * direct callers and tests.
 */
function resolveLayerList(
  template: BriefTemplate | undefined,
  creativeType: CreativeType | undefined,
): readonly CreativeTemplateLayer[] {
  if (template !== undefined) return template.layers;
  if (creativeType !== undefined) return CANONICAL_TEMPLATES[creativeType].layers;
  return CANONICAL_TEMPLATES["image-text"].layers;
}

/**
 * One layer of the draw: look the kind up in the dispatch table and paint it.
 * A kind with no entry — `fill`, `html` (L6) — throws, never skips: a
 * silently dropped layer is a redesign the goldens cannot see.
 */
function drawLayer(kind: LayerKind, c: LayerDrawContext): void {
  const drawer = LAYER_DRAWERS[kind];
  if (drawer === undefined) {
    throw new Error(
      `NodeCanvasCompositor: layer kind "${kind}" has no drawer in this compositor — it draws image, video, shade, accent, static-text, animated-text and logo only`,
    );
  }
  drawer(c);
}
