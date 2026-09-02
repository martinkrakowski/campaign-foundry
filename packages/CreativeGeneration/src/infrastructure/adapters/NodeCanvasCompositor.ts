import { readFile } from "node:fs/promises";
import { createCanvas, loadImage, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import {
  beatAt,
  resolveTimeline,
  resolveStyle,
  type CompositeRequest,
  type CompositeResult,
  type CompositorPort,
  type CopyTimeline,
  type MotionKind,
  type ResolvedBeat,
  type ResolvedStyle,
  type SafeInsets,
  type AnchorKind,
} from "@campaignfoundry/CampaignOrchestration";
import { CREATIVE_GEOMETRY } from "@campaignfoundry/CampaignOrchestration/creative-geometry";
import { hexToRgb, wrapText } from "./canvas-util.js";
import { registerBundledFonts } from "../fonts.js";
import { resolveAssetPath } from "../safe-path.js";

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
  readonly logoApplied: boolean;
  /** Normalized safe-zone insets; zeros when the request omitted them. */
  readonly insets: SafeInsets;
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
  /** The key beat's layout: what the poster shows (D7) and the logo rests against. */
  readonly anchorLayout?: HeadlineLayout;
}

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
 * Still path: {@link NodeCanvasCompositor.prepare} (I/O) →
 * {@link NodeCanvasCompositor.draw} at `t = 1` with no `motion`.
 */
export class NodeCanvasCompositor implements CompositorPort {
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
   */
  static draw(
    ctx: SKRSContext2D,
    prepared: PreparedCreative,
    t: number,
    motion?: MotionKind,
    copyT?: number,
  ): void {
    if (
      prepared.timeline !== undefined &&
      prepared.beatLayouts !== undefined &&
      prepared.anchorLayout !== undefined
    ) {
      const scenes: BeatScenes = {
        resolved: prepared.timeline,
        beats: prepared.beatLayouts,
        anchor: prepared.anchorLayout,
      };
      drawTimeline(ctx, prepared, scenes, t, motion, copyT ?? t);
      return;
    }
    NodeCanvasCompositor.drawLegacy(ctx, prepared, t, motion);
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
   * {@link NodeCanvasCompositor.draw}. The geometry literals below (band
   * heights) mirror the values in `CREATIVE_GEOMETRY` and must stay in
   * lockstep with it; the goldens pin them.
   */
  static drawLegacy(ctx: SKRSContext2D, prepared: PreparedCreative, t: number, motion?: MotionKind): void {
    const { width, height, top, shadeAlpha } = prepared;
    const eased = motion === undefined ? 1 : easeOutCubic(t);

    // Layer 1 — background. Ken-burns zooms this layer only, around the canvas centre.
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

    // Layer 2 — contrast shade, darkest at the headline edge, fading into the image.
    const shade = top
      ? ctx.createLinearGradient(0, height * 0.55, 0, 0)
      : ctx.createLinearGradient(0, height * 0.45, 0, height);
    shade.addColorStop(0, "rgba(0, 0, 0, 0)");
    shade.addColorStop(1, `rgba(0, 0, 0, ${shadeAlpha})`);
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, width, height);

    // Layer 3 — brand-colour accent band: a solid base flush to the headline edge
    // plus a soft fade into the image. Solid stays opaque in every tone, and this
    // band — not the logo — is what guarantees the brand-density compliance floor.
    const [ar, ag, ab] = hexToRgb(prepared.brandColor);
    const solidH = height * 0.05;
    const fadeH = height * 0.06;
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

    // Layer 4 — campaign copy, wrapped to the inset-reduced width and placed
    // in the inset rectangle per the prepared style's alignment (D10 amendment,
    // T5). wrapText uses this ctx so metrics match the blit.
    const headline = layoutHeadline(ctx, prepared);
    const rise = motion === "headline-rise";
    const dy = rise ? (1 - eased) * 0.12 * height : 0;
    const alpha = rise ? eased : 1;
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = prepared.style.align;
    ctx.textBaseline = "alphabetic";
    // A ctx-state control (F5a): re-stated at the blit, not inherited from the
    // layout pass — the default 0px is a no-op, the goldens pin it.
    ctx.letterSpacing = `${prepared.style.letterSpacing * headline.fontSize}px`;
    if (dy !== 0 || alpha !== 1) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(0, dy);
    }
    let y = headline.firstY;
    for (const line of headline.lines) {
      ctx.fillText(line, headlineTextX(prepared, headline.centerX), y);
      y += headline.lineHeight;
    }
    if (dy !== 0 || alpha !== 1) {
      ctx.restore();
    }

    // Layer 5 — brand logo, anchored opposite the headline (top-right for a bottom
    // headline, bottom-left for a top headline). Inset offset was captured in
    // prepare; if the rest-pose headline block overlaps it, snap to an inset edge.
    // The rest-pose box (not the translated one) keeps the logo static across `t`.
    if (prepared.logo) {
      const { image, x, width: lw, height: lh } = prepared.logo;
      let ly = prepared.logo.y;
      const logoBox = { x, y: ly, width: lw, height: lh };
      if (boxesOverlap(headline.box, logoBox)) {
        ly = resolveOverlappingLogoY(prepared, headline.box, lw, lh, x);
      }
      ctx.drawImage(image, x, ly, lw, lh);
    }
  }

  /**
   * Load background + logo and capture everything {@link NodeCanvasCompositor.draw}
   * needs. When the request carries `copy.timeline` *and* `durationSec`, the whole
   * beat sequence is resolved and fitted once here (D6/D9) — a still (no
   * durationSec) or a timeline-free request never resolves a timeline (D10).
   */
  static async prepare(
    request: CompositeRequest & { readonly durationSec?: number; readonly timeline?: CopyTimeline },
    fontFamily: string = "Inter",
  ): Promise<PreparedCreative> {
    const { width, height } = request.ratio;
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

    // Whether the logo applies is a brand-compliance signal the use case records
    // on the asset. The path is brief-supplied (untrusted), so it's resolved
    // through resolveAssetPath.
    let logo: PreparedCreative["logo"];
    let logoApplied = false;
    const logoPath = resolveAssetPath(request.logoPath);
    if (logoPath) {
      try {
        const image = await loadImage(await readFile(logoPath));
        const target = width * CREATIVE_GEOMETRY.logoWidthFraction;
        const scale = target / image.width;
        const logoH = image.height * scale;
        const margin = width * CREATIVE_GEOMETRY.logoMarginFraction;
        // Inset offset lives here so every still — and later every motion frame —
        // reuses the same logo geometry (`t` does not move the logo). Same additive
        // form as the pre-inset anchors so a no-op clamp stays bit-identical.
        const rawX = (top ? margin : width - target - margin) + (top ? insets.left : -insets.right);
        const rawY = (top ? height - logoH - margin : margin) + (top ? -insets.bottom : insets.top);
        const lx = clampInRange(rawX, insets.left, width - insets.right - target);
        const ly = clampInRange(rawY, insets.top, height - insets.bottom - logoH);
        logo = { image, x: lx, y: ly, width: target, height: logoH };
        logoApplied = true;
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

    const base: Omit<PreparedCreative, "timeline" | "beatLayouts" | "anchorLayout"> = {
      width,
      height,
      top,
      anchor,
      shadeAlpha,
      fontWeight: style.fontWeight,
      fontFamily: style.fontFamily,
      style,
      message: request.message,
      brandColor: request.brandColor,
      background,
      logo,
      logoApplied,
      insets,
    };

    // Sequenced copy: resolve windows and fit every beat at one common type size
    // (D6) right here, so `draw` (every frame, the poster, and every sample) pays
    // nothing but the blit. Still requests have no durationSec and no windows.
    if (request.timeline !== undefined && request.durationSec !== undefined) {
      return { ...base, ...resolveBeatLayouts(base, request.timeline, request.durationSec) };
    }
    return base;
  }

  async compositeAsset(request: CompositeRequest): Promise<CompositeResult> {
    const prepared = await NodeCanvasCompositor.prepare(request, this.fontFamily);
    const canvas = createCanvas(prepared.width, prepared.height);
    const ctx = canvas.getContext("2d");
    NodeCanvasCompositor.draw(ctx, prepared, 1);
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
  "width" | "height" | "top" | "anchor" | "fontWeight" | "fontFamily" | "style" | "insets"
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
  const originalFontSize = Math.round(p.width * p.style.sizeScale);
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
  const innerWidth = p.width - p.insets.left - p.insets.right;
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
      x: centerX - attempt.wrapWidth / 2,
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

/** Everything `draw` needs once the request resolved a timeline (D6/D9). */
interface BeatScenes {
  readonly resolved: readonly ResolvedBeat[];
  readonly beats: ReadonlyMap<string, HeadlineLayout>;
  readonly anchor: HeadlineLayout;
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
 * The sequenced-copy draw path. Layers 1–3, the text layer, and the logo layer
 * each match the legacy blit for the same `motion` / `t`; the only differences
 * are that copy is chosen by `copyT` (passed by the caller — the poster passes
 * the key beat's mid-time, D7) and that `headline-rise` advances per beat on the
 * pose clock `t` (each beat rises on its own local progress).
 */
function drawTimeline(
  ctx: SKRSContext2D,
  prepared: PreparedCreative,
  scenes: BeatScenes,
  t: number,
  motion: MotionKind | undefined,
  copyT: number,
): void {
  const eased = motion === undefined ? 1 : easeOutCubic(t);

  // Layers 1–3 — identical to the legacy blit for this motion / pose clock.
  paintBackground(ctx, prepared, eased, motion);
  paintShade(ctx, prepared);
  paintAccent(ctx, prepared, eased, motion);

  // Layer 4 — sequenced copy: the beat is selected by copyT, crossfaded with any
  // incoming beat, and (for headline-rise) eased on its own local progress.
  const pair = beatAt(scenes.resolved, copyT);
  const rise = motion === "headline-rise";
  if (pair.mix > 0 && pair.incoming !== undefined) {
    drawBeat(ctx, prepared, scenes, pair.current, 1 - pair.mix, t, rise);
    drawBeat(ctx, prepared, scenes, pair.incoming, pair.mix, t, rise);
  } else {
    drawBeat(ctx, prepared, scenes, pair.current, 1, t, rise);
  }

  // Layer 5 — brand logo, anchored to the key beat's rest-pose box, so it neither
  // jumps between beats nor drifts from the poster (D7).
  if (prepared.logo) {
    const { image, x, width: lw, height: lh } = prepared.logo;
    let ly = prepared.logo.y;
    const logoBox = { x, y: ly, width: lw, height: lh };
    if (boxesOverlap(scenes.anchor.box, logoBox)) {
      ly = resolveOverlappingLogoY(prepared, scenes.anchor.box, lw, lh, x);
    }
    ctx.drawImage(image, x, ly, lw, lh);
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
): void {
  const layout = scenes.beats.get(beat.text);
  if (layout === undefined) {
    throw new Error(`NodeCanvasCompositor: no fitted layout for beat "${beat.text}".`);
  }
  // Local progress inside the beat's own window, so headline-rise resets with
  // each beat (Q1) while the global pose clock keeps the ground layers continuous.
  const local = clamp01((t - beat.startT) / (beat.endT - beat.startT));
  const eased = rise ? easeOutCubic(local) : 1;
  const dy = rise ? (1 - eased) * 0.12 * prepared.height : 0;
  const alpha = rise ? eased : 1;
  const opacity = alpha * layerAlpha;
  ctx.fillStyle = "#ffffff";
  // F5a: this path measures on a throwaway 1×1 context and re-sets ctx.font
  // below, so every ctx-state control is (re-)stated HERE, not inherited — a
  // control applied only at the still would silently drop from the video blit.
  ctx.textAlign = prepared.style.align;
  ctx.textBaseline = "alphabetic";
  /* mutated */
  ctx.letterSpacing = `${prepared.style.letterSpacing * layout.fontSize}px`;
  ctx.font = `${prepared.fontWeight} ${layout.fontSize}px ${prepared.fontFamily}, sans-serif`;
  if (dy !== 0 || opacity !== 1) {
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.translate(0, dy);
  }
  let y = layout.firstY;
  for (const line of layout.lines) {
    ctx.fillText(line, headlineTextX(prepared, layout.centerX), y);
    y += layout.lineHeight;
  }
  if (dy !== 0 || opacity !== 1) {
    ctx.restore();
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Timeline-path layer 1 — background (identical to the legacy blit for the same `motion`/`eased`). */
function paintBackground(
  ctx: SKRSContext2D,
  prepared: PreparedCreative,
  eased: number,
  motion: MotionKind | undefined,
): void {
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

/** Timeline-path layer 2 — contrast shade, darkest at the headline edge. */
function paintShade(ctx: SKRSContext2D, prepared: PreparedCreative): void {
  const { width, height, top, shadeAlpha } = prepared;
  const shade = top
    ? ctx.createLinearGradient(0, height * 0.55, 0, 0)
    : ctx.createLinearGradient(0, height * 0.45, 0, height);
  shade.addColorStop(0, "rgba(0, 0, 0, 0)");
  shade.addColorStop(1, `rgba(0, 0, 0, ${shadeAlpha})`);
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, width, height);
}

/** Timeline-path layer 3 — brand-colour accent band (solid base + wipe fade). */
function paintAccent(
  ctx: SKRSContext2D,
  prepared: PreparedCreative,
  eased: number,
  motion: MotionKind | undefined,
): void {
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
