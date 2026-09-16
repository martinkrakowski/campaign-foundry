import { readFile } from "node:fs/promises";
import { createCanvas, loadImage, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import {
  CANONICAL_TEMPLATES,
  accentWipeFraction,
  beatAt,
  copyMotionTracks,
  easeOutCubic,
  groundMotionTracks,
  poseOf,
  resolveCanvas,
  resolveTimeline,
  resolveStyle,
  resolveTracks,
  scaleBasis,
  textEffectTracks,
  widthTermBasis,
  type CanvasSpec,
  type CompositeRequest,
  type CompositeResult,
  type CompositorPort,
  type CopyTimeline,
  type MotionKind,
  type Pose,
  type ResolvedBeat,
  type ResolvedStyle,
  type SafeInsets,
  type AnchorKind,
  type TextEffectKind,
  type BriefTemplate,
  type CreativeTemplateLayer,
  type CreativeType,
  type LayerKind,
  type AccentProps,
  type LogoProps,
  type TextProps,
  toneFontWeight,
  htmlTextGeometry,
  htmlButtonFontSize,
  htmlTextFirstLineOffset,
  htmlElementFont,
} from "@campaignfoundry/CampaignOrchestration";
import { CREATIVE_GEOMETRY } from "@campaignfoundry/CampaignOrchestration/creative-geometry";
import { hexToRgb, wrapText } from "./canvas-util.js";
import { registerBundledFonts } from "../fonts.js";
import { resolveAssetPath } from "../safe-path.js";

// Re-export so A2's compositor tests keep importing from this module; the
// functions live in the domain (lint:arch — the editor must not reach here).
export { scaleBasis, widthTermBasis };

/**
 * The one geometry merge (C4, R-D3): `CREATIVE_GEOMETRY` is the default and a
 * layer's `props` is the override — every reader of one of the four live
 * quantities calls this and never the constant directly. An absent prop is
 * `undefined`, so the default stands and a props-free template renders the
 * exact bytes it rendered before the merge; a present prop is already a
 * fraction validated into `[0, 1]` at both boundaries (D134), comparable to the
 * constant it overrides.
 *
 * Only these four quantities route through here: `accent`'s `solidHeight` and
 * `fadeHeight`, `logo`'s `width` and `margin`, and the text layers'
 * `typeFloor`. `anchor` (text) and `alpha` (shade) are deliberately NOT merged:
 * each shadows a variation axis — the anchor axis and the tone axis — and which
 * of the prop or the axis wins is an open owner decision, so both still read
 * their axis exactly as they do today (C4 reduced scope).
 *
 * Two different call sites, same merge: `paintAccent` reads `c.layer.props`
 * straight off the dispatched {@link LayerDrawContext} — `maxOf.accent === 1`
 * (D124) means it is the only enabled accent layer a template can carry, so
 * "the layer this drawer was dispatched for" and "the enabled accent layer"
 * are the same layer. `logo`'s width/margin and the text layers' `typeFloor`
 * are resolved once in `prepare` instead, for two different reasons: the logo
 * block (position, scale) is computed once and reused by every draw/frame
 * (`maxOf.logo === 1` makes "find the enabled logo layer" safe the same way),
 * and `headlineTypeFloor` specifically MUST be resolved in `prepare` because
 * `fitText` also runs there — on the throwaway measure context building
 * `logoAnchorLayout`, and again per beat in `resolveBeatLayouts` — neither of
 * which carries a `LayerDrawContext` to read `c.layer` from.
 */
function mergeGeometry(defaultFraction: number, override: number | undefined): number {
  return override ?? defaultFraction;
}


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
  /**
   * The autofit floor as a fraction of the starting type size (C4, R-D3): the
   * `CREATIVE_GEOMETRY` default, overridden by the text layer's `typeFloor`
   * prop when it carries one. Resolved once in `prepare` (the text-kind budget
   * is one) and read by `fitText` through `LayoutSource`, so no reader touches
   * the floor constant directly. Absent prop → the constant → today's bytes.
   */
  readonly headlineTypeFloor: number;
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
  /**
   * Decoded per-scene grounds (VE5b1), keyed by the same asset path a beat's
   * `background` names — one decode per distinct key an actual beat
   * references (never the whole `backgrounds` map: an unreferenced entry is
   * neither decoded nor a reason to fail), done here (not per frame/beat) the
   * same way `background` above is decoded once. `undefined` when no beat
   * references any supplied key, which keeps every timeline-free or
   * scene-free request on exactly today's path: `paintBackground` never
   * looks here unless both this and `timeline` are set.
   */
  readonly scenes?: ReadonlyMap<string, Image>;
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
   * in `prepare` as *logo file loaded AND the resolved layer list contains an
   * enabled `logo` layer* — the load alone is not the signal, the layer is
   * optional (F2), and a disabled one draws nothing (X9), so a template that
   * omits or switches it off draws no logo pixels.
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
 * creative, the layer being dispatched, and the pose values the draw path
 * computed once. One object serves every drawer (D121). The logo's overlap
 * snap reads its anchor box off `prepared.logoAnchorLayout` (C5) — resolved
 * once in `prepare`, independent of draw order — so this context carries no
 * drawer-to-drawer handoff field. `layer` is the dispatched entry itself
 * (HL3): the compositor iterates the list per layer, and a template may carry
 * more than one layer of a kind — a drawer with per-layer data (today only
 * {@link drawHtml}) must read it from what it was dispatched for, never by
 * hunting the list. Siblings ignore the field.
 */
interface LayerDrawContext {
  readonly ctx: SKRSContext2D;
  readonly prepared: PreparedCreative;
  readonly layer: CreativeTemplateLayer;
  readonly motion: MotionKind | undefined;
  /**
   * The raw pose clock (K2): the `t` `draw()` was called with, independent of
   * `eased`, `easeOutCubic(t)`'s pre-applied form `eased` already carries.
   * `resolveTracks` applies its OWN (per-stop) easing internally, so a
   * ground-layer motion track (`groundMotionTracks`, `paintBackground`) reads
   * this, never `eased`.
   */
  readonly t: number;
  readonly eased: number;
  readonly effectT: number;
  /**
   * The copy clock (VE5b1): which beat's scene `paintBackground` paints, the
   * same `copyT ?? t` that selects the beat's copy. Only `drawTimeline` sets
   * it — `drawLegacy` never carries a timeline, so `paintBackground` there
   * always draws `prepared.background`, byte-identical to before this field
   * existed.
   */
  readonly copyT?: number;
}

/**
 * Kind → drawer (D121): the draw order is the template's layer list; this
 * table owns kind → code. `animated-text` maps to the same drawer as
 * `static-text` (D127): the kind names the capability and its props select
 * which mechanism drives it, and a still frame of animated text is its rest
 * pose — exactly what drawStaticText paints; the moving path is L6/L11's.
 * `video` maps to the same drawer as `image` (VD): video is the output frame
 * sequence rather than an input asset, and on any single frame the background
 * is a still image blit (with a `groundMotionTracks`-resolved zoom applied in
 * motion, K2).
 * Kinds this compositor cannot draw (`fill`) are absent, and
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
  html: drawHtml,
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
 * throws the same way on both. A layer the brief disabled (`enabled: false`,
 * D129 — absence means enabled) draws on neither path: the skip is in the two
 * dispatch loops, ahead of the copy-budget guard, so it holds for every kind at
 * once, and a disabled layer never spends the enabled one's turn (X9).
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
    const c: Omit<LayerDrawContext, "layer"> = {
      ctx,
      prepared,
      motion,
      t,
      eased: motion === undefined ? 1 : easeOutCubic(t),
      effectT,
    };
    // The draw order is the layer list (D121/D128): array position is z-order,
    // bottom first. A kind with no table entry throws — it never skips.
    let copyDrawn = false;
    for (const layer of prepared.layers) {
      // A layer the brief disabled does not draw (X9). The check runs BEFORE
      // the copy guard below: a disabled copy layer that set `copyDrawn` would
      // silently drop the enabled copy that follows it.
      if (isDisabledLayer(layer)) continue;
      if (layer.kind === "static-text" || layer.kind === "animated-text") {
        // A creative type's shared budget caps text-kind layers at one (D124);
        // this guard is defensive, not load-bearing — never draws copy twice.
        if (copyDrawn) continue;
        copyDrawn = true;
      }
      drawLayer(layer, c);
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
       * Per-scene grounds (VE5b1) — see `VideoCompositeRequest.backgrounds`.
       * Absent (every still, and a timeline-free or scene-free video request)
       * means every ground layer paints `request.background`, as before.
       */
      readonly backgrounds?: Readonly<Record<string, Uint8Array>>;
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
    // The resolved draw order (D121/D128) — resolved here so `logoApplied`
    // below can be derived from what the draw will actually paint, and so
    // `textProps` is available before anchor resolves (R-D4).
    const layers = resolveLayerList(request.template, request.creativeType);
    const textProps = (layers.find(
      (layer) =>
        (layer.kind === "static-text" || layer.kind === "animated-text") &&
        layer.enabled !== false,
    )?.props ?? {}) as TextProps;
    // The anchor axis (T4) wins over the text layer's `anchor` prop (R-D4 —
    // a prop never shadows a live axis): absent axis and absent prop both
    // fall to layout-derived, the pre-axis behaviour bit for bit (D54 — the
    // goldens pin both derived paths).
    const anchor: AnchorKind = request.anchor ?? textProps.anchor ?? (top ? "top" : "bottom");
    const subtle = request.tone === "subtle";
    const shadeAlpha = subtle
      ? CREATIVE_GEOMETRY.shadeAlpha.subtle
      : CREATIVE_GEOMETRY.shadeAlpha.bold;
    // HL5f: the ONE tone→weight rule, shared with `assembleHtml` — the gap
    // HL-D8 names ("subtle" render Regular, everything else Bold), never
    // restated as a second ternary.
    const fontWeight = toneFontWeight(request.tone);
    // The style block (T5): resolved once here, every absent field falling to
    // today's literal (D54) and the weight to the tone-derived one (D60). The
    // brief's family — a parse-validated allowlist member — overrides the
    // deployment default; with no style block the deployment default stands.
    const style = resolveStyle(request.style, fontWeight, fontFamily);
    const insets = normalizeSafeInsets(request.safeInsets, width, height);

    const background = await loadImage(Buffer.from(request.background));
    // Per-scene grounds (VE5b1): decode each distinct ground an actual beat
    // references, the same decode `background` above just used — never the
    // whole `backgrounds` map. `request.timeline` (not the not-yet-resolved
    // beats) already carries every beat's own `background` verbatim, so the
    // referenced set is known before `resolveBeatLayouts` runs. Decoding an
    // unreferenced entry would spend concurrency and memory on bytes nothing
    // draws, and let one corrupt unreferenced entry abort a render nothing
    // needed it for (review finding). `paintBackground` looks scenes up by the
    // active beat's own `background` path — VE-D3's fallback is simply a key
    // this map does not have.
    const referencedBackgrounds = new Set(
      (request.timeline?.beats ?? []).flatMap((beat) => (beat.background !== undefined ? [beat.background] : [])),
    );
    const backgroundEntries =
      request.backgrounds !== undefined
        ? Object.entries(request.backgrounds).filter(([path]) => referencedBackgrounds.has(path))
        : [];
    const scenes: ReadonlyMap<string, Image> | undefined =
      backgroundEntries.length > 0
        ? new Map(
            await Promise.all(
              backgroundEntries.map(
                async ([path, bytes]) => [path, await loadImage(Buffer.from(bytes))] as const,
              ),
            ),
          )
        : undefined;

    // The autofit floor merge (C4, R-D3): the enabled text layer's `typeFloor`
    // prop over the `CREATIVE_GEOMETRY` default, resolved once because the
    // text-kind budget is one (D124) and `fitText` reads it off `LayoutSource`.
    const headlineTypeFloor = mergeGeometry(
      CREATIVE_GEOMETRY.headlineTypeFloorFraction,
      textProps.typeFloor,
    );

    // Whether the logo applies is a brand-compliance signal the use case records
    // on the asset. The path is brief-supplied (untrusted), so it's resolved
    // through resolveAssetPath.
    let logo: PreparedCreative["logo"];
    let logoLoaded = false;
    const logoPath = resolveAssetPath(request.logoPath);
    if (logoPath) {
      try {
        const image = await loadImage(await readFile(logoPath));
        // The block's own geometry merge (C4, R-D3): the enabled `logo` layer's
        // width/margin props over the `CREATIVE_GEOMETRY` default. Absent → the
        // constant → the pre-merge bytes (the goldens pin them).
        const logoProps = (layers.find(
          (layer) => layer.kind === "logo" && layer.enabled !== false,
        )?.props ?? {}) as LogoProps;
        const target =
          scaleBasis(canvas, width, height) *
          mergeGeometry(CREATIVE_GEOMETRY.logoWidthFraction, logoProps.width);
        const scale = target / image.width;
        const logoH = image.height * scale;
        const margin =
          widthTermBasis(canvas, width, height) *
          mergeGeometry(CREATIVE_GEOMETRY.logoMarginFraction, logoProps.margin);
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
    // resolved list carries an ENABLED `logo` layer" is exactly the logo drawer
    // painting (X9: a disabled layer draws nothing, so it cannot have applied
    // the brand); computed here, where the list is resolved, never by mutating
    // shared state mid-draw.
    const logoApplied =
      logoLoaded && layers.some((layer) => layer.kind === "logo" && layer.enabled !== false);

    const base: Omit<
      PreparedCreative,
      "timeline" | "beatLayouts" | "anchorLayout" | "logoAnchorLayout"
    > = {
      canvas,
      width,
      height,
      top,
      anchor,
      headlineTypeFloor,
      shadeAlpha,
      fontWeight: style.fontWeight,
      fontFamily: style.fontFamily,
      style,
      textEffect: style.textEffect,
      message: request.message,
      brandColor: request.brandColor,
      background,
      scenes,
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
  "canvas" | "width" | "height" | "top" | "anchor" | "headlineTypeFloor" | "fontWeight" | "fontFamily" | "style" | "insets"
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
  const floor = Math.round(originalFontSize * p.headlineTypeFloor);

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
 * can draw (`fill`) throws the same "no drawer" error here as it does
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
  const c: Omit<LayerDrawContext, "layer"> = { ctx, prepared, motion, t, eased, effectT: effectT ?? t, copyT };
  let copyDrawn = false;
  for (const layer of prepared.layers) {
    // A layer the brief disabled does not draw (X9), and the check runs BEFORE
    // the copy guard below: a disabled copy layer that consumed the budget
    // would silently drop the enabled copy that follows it.
    if (isDisabledLayer(layer)) continue;
    if (layer.kind === "static-text" || layer.kind === "animated-text") {
      // A creative type's shared budget caps text-kind layers at one (D124);
      // this guard is defensive, not load-bearing — never draws the beat twice.
      if (copyDrawn) continue;
      drawSequencedCopy(ctx, prepared, scenes, layer, copyT, t, motion, effectT);
      copyDrawn = true;
      continue;
    }
    drawLayer(layer, c);
  }
}

/**
 * Layer 4 — sequenced copy: the beat is selected by `copyT`, crossfaded with
 * any incoming beat, and (for headline-rise) eased on its own local progress.
 * Extracted verbatim from `drawTimeline`'s former fixed post-loop call (C5) —
 * only WHEN this runs changed (at the copy layer's list position), never HOW.
 *
 * **K2**: the per-kind `motion` comparison for headline-rise no longer lives here — `resolveTracks`
 * is called ONCE, with the real `scenes.resolved` beats and the same
 * `{ t, copyT, effectT }` clocks `beatAt(scenes.resolved, copyT)` already
 * used below, so its internal beat pairing is the exact same pairing this
 * function used to compute by hand; `resolved.copy` then carries one
 * `{ beat, mix, pose }` entry per live beat (one, or two during a
 * crossfade — K-D6), in the same `(current, incoming)` order the old
 * `if (pair.mix > 0 ...)` branch drew them in.
 *
 * **K3**: the text effect's tracks (`textEffectTracks`) are appended to the
 * SAME layer entry's `tracks`, after the motion tracks — one `resolveTracks`
 * call, one fold, in the old composition order (`opacity = (riseAlpha *
 * fx.alpha) * layerAlpha`, K-D9). Both track sources land on the `effect`/
 * `beat` clocks `resolveTracks` already reads per live beat (`local`, one per
 * `(beat, mix)` pair), so `entry.pose` arrives fully composed — `drawBeat` no
 * longer computes a text-effect pose of its own.
 *
 * **K4**: the layer's own hand-authored `tracks` (K1a) are appended LAST, after
 * both synthesized sources — never invented, K-D9's declaration-order fold
 * already decides this: preset expansions fold before the authored tracks, so
 * a brief that authors no tracks (`layer.tracks` undefined) spreads an empty
 * array and folds exactly as before (byte-identical).
 */
function drawSequencedCopy(
  ctx: SKRSContext2D,
  prepared: PreparedCreative,
  scenes: BeatScenes,
  layer: CreativeTemplateLayer,
  copyT: number,
  t: number,
  motion: MotionKind | undefined,
  effectT: number | undefined,
): void {
  const resolved = resolveTracks(
    [
      {
        id: layer.id,
        kind: layer.kind,
        tracks: [
          ...copyMotionTracks(motion, prepared.height),
          ...textEffectTracks(prepared.textEffect, prepared.canvas, prepared.width, prepared.height),
          ...(layer.tracks ?? []),
        ],
      },
    ],
    scenes.resolved,
    { t, copyT, effectT },
  );
  for (const entry of resolved.copy) {
    drawBeat(ctx, prepared, scenes, entry.beat, entry.mix, entry.pose);
  }
}

/** Paint one beat's copy at the given layer opacity (`1 - mix` / `mix` during a crossfade). */
function drawBeat(
  ctx: SKRSContext2D,
  prepared: PreparedCreative,
  scenes: BeatScenes,
  beat: ResolvedBeat,
  layerAlpha: number,
  pose: Pose,
): void {
  const layout = scenes.beats.get(beat.text);
  if (layout === undefined) {
    throw new Error(`NodeCanvasCompositor: no fitted layout for beat "${beat.text}".`);
  }
  // `pose` already carries the motion kind's and the text effect's composed
  // contribution (K2/K3) — the beat's exit mix (`layerAlpha`) is the only
  // thing this drawer still applies on top.
  const opacity = pose.opacity * layerAlpha;
  ctx.fillStyle = "#ffffff";
  // F5a: this path measures on a throwaway 1×1 context and re-sets ctx.font
  // below, so every ctx-state control is (re-)stated HERE, not inherited — a
  // control applied only at the still would silently drop from the video blit.
  ctx.textAlign = prepared.style.align;
  ctx.textBaseline = "alphabetic";
  ctx.letterSpacing = `${prepared.style.letterSpacing * layout.fontSize}px`;
  ctx.font = `${prepared.fontWeight} ${layout.fontSize}px ${prepared.fontFamily}, sans-serif`;
  const posed = openTextPose(ctx, opacity, pose.dx, pose.dy, pose.scale, layout);
  let y = layout.firstY;
  for (const line of layout.lines) {
    ctx.fillText(line, headlineTextX(prepared, layout.centerX), y);
    y += layout.lineHeight;
  }
  if (posed) {
    ctx.restore();
  }
}

/** Which decoded ground(s) `paintBackground` should draw, and at what mix. */
interface GroundPose {
  readonly current: Image;
  readonly incoming?: Image;
  readonly mix: number;
}

/**
 * The ground active at `copyT` (VE5b1): the same beat-selection and crossfade
 * that already drives the copy layer (`beatAt`), applied to the paired scene
 * instead of the paired text. `cut` never carries a fade (`mix` stays 0), so
 * only `fade` timelines ever return an `incoming` ground.
 *
 * Falls back to `prepared.background` — the creative's own ground — whenever
 * there is nothing to select over (no timeline, no supplied scenes, no copy
 * clock) or a beat names a background absent from what the request supplied
 * (VE-D3): both are the same "no entry for this key" case, never a special
 * branch.
 */
function selectGround(prepared: PreparedCreative, copyT: number | undefined): GroundPose {
  if (prepared.timeline === undefined || prepared.scenes === undefined || copyT === undefined) {
    return { current: prepared.background, mix: 0 };
  }
  const scenes = prepared.scenes;
  const groundFor = (beat: ResolvedBeat): Image =>
    (beat.background !== undefined ? scenes.get(beat.background) : undefined) ?? prepared.background;
  const pair = beatAt(prepared.timeline, copyT);
  const current = groundFor(pair.current);
  if (pair.incoming === undefined || pair.mix === 0) {
    return { current, mix: 0 };
  }
  return { current, incoming: groundFor(pair.incoming), mix: pair.mix };
}

/** Blit one ground image under the shared ken-burns zoom, at an optional layer alpha. */
function drawGroundImage(
  ctx: SKRSContext2D,
  image: Image,
  width: number,
  height: number,
  zoom: number,
  alpha: number,
): void {
  // `alpha === 1` never touches globalAlpha, so the no-scene path is exactly
  // the pre-VE5b1 call sequence — byte-identical (VE-D3).
  if (alpha !== 1) ctx.globalAlpha = alpha;
  if (zoom === 1) {
    ctx.drawImage(image, 0, 0, width, height);
  } else {
    ctx.save();
    ctx.translate(width / 2, height / 2);
    ctx.scale(zoom, zoom);
    ctx.translate(-width / 2, -height / 2);
    ctx.drawImage(image, 0, 0, width, height);
    ctx.restore();
  }
  if (alpha !== 1) ctx.globalAlpha = 1;
}

/**
 * The image layer — the background buffer; ken-burns zooms this layer only
 * (D121). VE5b1: at a `copyT`, paints whichever scene the active beat names
 * (falling back to the creative's own ground), crossfading the outgoing and
 * incoming scenes with the exact `mix` the copy layer crossfades at — the
 * poster gets this for free, since it reaches here through the same `copyT`
 * the copy layer already uses (no poster-specific branch).
 *
 * **K2**: the zoom is a resolved `scale` pose, not a `motion === "ken-burns-*"`
 * branch — `groundMotionTracks` expands the kind into a `pose`-clock `scale`
 * track (or none), `resolveTracks` folds it against the raw pose clock
 * (`c.t`, not `eased` — the resolver applies its own per-stop easing), and
 * `poseOf` defaults a trackless layer to the identity scale (1), exactly
 * `kenBurnsScale`'s old `else 1`.
 *
 * **K4**: the layer's own hand-authored `tracks` fold in LAST, after the
 * synthesized ken-burns expansion — an absent `layer.tracks` spreads an
 * empty array, byte-identical to before.
 */
function paintBackground(c: LayerDrawContext): void {
  const { ctx, prepared, motion, t, copyT, layer } = c;
  const { width, height } = prepared;
  const resolved = resolveTracks(
    [
      {
        id: layer.id,
        kind: layer.kind,
        tracks: [...groundMotionTracks(motion), ...(layer.tracks ?? [])],
      },
    ],
    [],
    { t },
  );
  const zoom = poseOf(resolved, layer.id).scale;
  const ground = selectGround(prepared, copyT);
  drawGroundImage(ctx, ground.current, width, height, zoom, 1);
  if (ground.incoming !== undefined && ground.mix > 0) {
    drawGroundImage(ctx, ground.incoming, width, height, zoom, ground.mix);
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
 * heights are the accent layer's own geometry merge (C4, R-D3): `c.layer` is
 * the entry this drawer was dispatched for (see {@link drawLayer}), and
 * `maxOf.accent === 1` (D124) means it is the only enabled accent layer a
 * template can carry — so reading its `props` here needs no list-hunting the
 * way `logo`/`typeFloor` do in `prepare`. Absent → the constant → the
 * pre-merge bytes (the goldens pin them).
 *
 * **K2**: the wipe is the one `MOTION_KINDS` member that stayed a
 * drawer-local animation rather than becoming a track (`accentWipeFraction`'s
 * own doc comment says why) — only the per-kind `motion` comparison for accent-wipe
 * itself moved into the domain.
 */
function paintAccent(c: LayerDrawContext): void {
  const { ctx, prepared, motion, eased, layer } = c;
  const { width, height, top } = prepared;
  const [ar, ag, ab] = hexToRgb(prepared.brandColor);
  const accentProps = (layer.props ?? {}) as AccentProps;
  const solidH =
    height * mergeGeometry(CREATIVE_GEOMETRY.accentSolidHeightFraction, accentProps.solidHeight);
  const fadeH =
    height * mergeGeometry(CREATIVE_GEOMETRY.accentFadeHeightFraction, accentProps.fadeHeight);
  const wipe = accentWipeFraction(motion, eased);
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
 * layout was resolved once in `prepare` (`prepared.logoAnchorLayout`, C5) and
 * shared with `drawLogo`, so this drawer's only job is painting — text fitting
 * is never repeated on the blit context. `ctx.font` is (re-)stated here per F5a.
 *
 * **K2**: the per-kind `motion` comparison for headline-rise no longer lives here — this is the
 * LEGACY (timeline-less) path, so there is no beat to resolve tracks against;
 * `resolveTracks`'s own legacy shortcut (`beats: []`) is exactly this
 * contract, one implicit beat with `local = t` (K-D8), which is what this
 * drawer's own `t` already is.
 *
 * **K3**: the text effect's tracks (`textEffectTracks`) join the motion
 * tracks in the same layer entry, so one `resolveTracks` call folds both —
 * `clocks.effectT` is this drawer's own `effectT` (always defined,
 * `LayerDrawContext`'s own contract), matching the old `effectT ?? local`
 * unification exactly. Composition order is preserved (motion tracks first,
 * effect tracks second, K-D9) inside that one fold.
 *
 * **K4**: the layer's own hand-authored `tracks` join the same entry, LAST —
 * an absent `layer.tracks` spreads an empty array, byte-identical to before.
 */
function drawStaticText(c: LayerDrawContext): void {
  const { ctx, prepared, motion, t, effectT, layer } = c;
  const { width, height } = prepared;
  // Layer 4 — campaign copy, wrapped to the inset-reduced width and placed
  // in the inset rectangle per the prepared style's alignment (D10 amendment,
  // T5). Reads the layout `prepare` already resolved (C5).
  const headline = prepared.logoAnchorLayout!;
  const resolved = resolveTracks(
    [
      {
        id: layer.id,
        kind: layer.kind,
        tracks: [
          ...copyMotionTracks(motion, height),
          ...textEffectTracks(prepared.textEffect, prepared.canvas, width, height),
          ...(layer.tracks ?? []),
        ],
      },
    ],
    [],
    { t, effectT },
  );
  const pose = resolved.copy[0]!.pose;
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = prepared.style.align;
  ctx.textBaseline = "alphabetic";
  // A ctx-state control (F5a): re-stated at the blit, not inherited from the
  // layout pass — the default 0px is a no-op, the goldens pin it.
  ctx.letterSpacing = `${prepared.style.letterSpacing * headline.fontSize}px`;
  ctx.font = `${prepared.fontWeight} ${headline.fontSize}px ${prepared.fontFamily}, sans-serif`;
  const posed = openTextPose(ctx, pose.opacity, pose.dx, pose.dy, pose.scale, headline);
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
 * The html layer (HL3, HL-D5) — draws the dispatched layer's element list
 * (text, button, image) directly onto the canvas, producing the static raster
 * fallback rendition (D122) before the markup assembler (HL4) is built. The
 * elements come from `c.layer` — the layer this draw was dispatched for (the
 * compositor iterates per layer, and nothing caps how many `html` layers a
 * template may carry, so hunting `prepared.layers` for "the" html layer would
 * paint the first list twice and never paint the second). Absent or empty
 * elements (e.g. the canonical template) is a no-op blit.
 */
function drawHtml(c: LayerDrawContext): void {
  const { ctx, prepared, layer } = c;
  if (layer.elements === undefined || layer.elements.length === 0) {
    return;
  }
  const { width, height } = prepared;
  for (const element of layer.elements) {
    const boxX = element.frame.x * width;
    const boxY = element.frame.y * height;
    const boxW = element.frame.w * width;
    const boxH = element.frame.h * height;

    switch (element.kind) {
      case "button": {
        const radius = Math.min(8, boxH / 2, boxW / 2);
        ctx.save();
        // Clip to the rounded shape the button is filled with: the markup's
        // `border-radius` + `overflow: hidden` clips its label to that shape too.
        ctx.beginPath();
        ctx.roundRect(boxX, boxY, boxW, boxH, radius);
        ctx.clip();
        ctx.fillStyle = prepared.brandColor;
        ctx.beginPath();
        ctx.roundRect(boxX, boxY, boxW, boxH, radius);
        ctx.fill();

        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const fontSize = htmlButtonFontSize(boxH, scaleBasis(prepared.canvas, width, height));
        // HL5e: the element's own font, resolved by the one function
        // `assembleHtml` also calls — the button's override if it names one,
        // the brief's resolved weight/family otherwise.
        const font = htmlElementFont(element, prepared);
        ctx.font = `${font.fontWeight} ${fontSize}px ${font.fontFamily}, sans-serif`;
        ctx.fillText(element.text!, boxX + boxW / 2, boxY + boxH / 2);
        ctx.restore();
        break;
      }
      case "text": {
        ctx.save();
        ctx.beginPath();
        ctx.rect(boxX, boxY, boxW, boxH);
        ctx.clip();
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = prepared.style.align;
        ctx.textBaseline = "alphabetic";
        // HL5f: font size, line height and letter spacing come from the one
        // function `assembleHtml` also calls — see `htmlTextGeometry`.
        const geometry = htmlTextGeometry({
          boxH,
          canvasBasis: scaleBasis(prepared.canvas, width, height),
          sizeScale: prepared.style.sizeScale,
          lineHeight: prepared.style.lineHeight,
          letterSpacing: prepared.style.letterSpacing,
        });
        const { fontSize, lineHeight, letterSpacing } = geometry;
        // HL5e: the element's own font, resolved by the one function
        // `assembleHtml` also calls — stated BEFORE the wrap below, which
        // measures with it, exactly as the browser lays out wrapped markup at
        // the same font the markup's inline style declares.
        const font = htmlElementFont(element, prepared);
        ctx.font = `${font.fontWeight} ${fontSize}px ${font.fontFamily}, sans-serif`;
        ctx.letterSpacing = `${letterSpacing}px`;

        const lines = wrapText(ctx, element.text!, boxW);
        // HL5f: the per-anchor baseline offset comes from the one function
        // `htmlTextFirstLineOffset` — see its comment: the MARKUP does not
        // consume that offset (it positions with CSS flex `justify-content`,
        // which the browser resolves against the real line count); this
        // canvas pass uses the REAL post-wrap line count.
        const startY = boxY + htmlTextFirstLineOffset(element.frame.anchor, boxH, fontSize, lineHeight, lines.length);

        let lineX: number;
        if (prepared.style.align === "left") {
          lineX = boxX;
        } else if (prepared.style.align === "right") {
          lineX = boxX + boxW;
        } else {
          lineX = boxX + boxW / 2;
        }

        let currY = startY;
        for (const line of lines) {
          ctx.fillText(line, lineX, currY);
          currY += lineHeight;
        }
        ctx.restore();
        break;
      }
      case "image": {
        ctx.save();
        ctx.drawImage(prepared.background, boxX, boxY, boxW, boxH);
        ctx.restore();
        break;
      }
    }
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
      if (!prepared.layers.some((layer) => layer.kind === "html")) {
        throw new Error(
          "NodeCanvasCompositor: the logo layer snaps to the text block, but there is no text layer in the template at all",
        );
      }
    }
    const { image, x, width: lw, height: lh } = prepared.logo;
    let ly = prepared.logo.y;
    if (anchor !== undefined) {
      const logoBox = { x, y: ly, width: lw, height: lh };
      if (boxesOverlap(anchor.box, logoBox)) {
        ly = resolveOverlappingLogoY(prepared, anchor.box, lw, lh, x);
      }
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
 * One layer of the draw: look the kind up in the dispatch table and paint it,
 * handing the drawer the layer it was dispatched for (HL3) — a template may
 * carry several layers of one kind, and the loop position is the only identity
 * the drawer can trust. A kind with no entry — `fill` (L6) — throws, never
 * skips: a silently dropped layer is a redesign the goldens cannot see.
 */
function drawLayer(layer: CreativeTemplateLayer, c: Omit<LayerDrawContext, "layer">): void {
  const drawer = LAYER_DRAWERS[layer.kind];
  if (drawer === undefined) {
    throw new Error(
      `NodeCanvasCompositor: layer kind "${layer.kind}" has no drawer in this compositor — it draws image, video, shade, accent, static-text, animated-text, logo and html only`,
    );
  }
  drawer({ ...c, layer });
}

/**
 * Whether a dispatch loop skips this layer (X9): an explicit `enabled: false`
 * (D129 — absence means enabled) hides a layer this compositor CAN draw, so a
 * disabled layer renders exactly what the same template with that layer absent
 * renders. A kind with no drawer is never skipped here: it still reaches
 * {@link drawLayer} and throws, because a brief naming an unsupported kind has
 * declared something this renderer cannot draw whether or not the operator
 * switched it off — silently dropping it would turn L6's refusal into the same
 * accepted-then-not-rendered promise this rule exists to keep.
 */
function isDisabledLayer(layer: CreativeTemplateLayer): boolean {
  return layer.enabled === false && LAYER_DRAWERS[layer.kind] !== undefined;
}
