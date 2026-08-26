import { readFile } from "node:fs/promises";
import { createCanvas, loadImage, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import type {
  CompositeRequest,
  CompositeResult,
  CompositorPort,
  MotionKind,
  SafeInsets,
} from "@campaignfoundry/CampaignOrchestration";
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
  readonly shadeAlpha: number;
  readonly fontWeight: string;
  readonly fontFamily: string;
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
   * kind; the solid accent and logo stay put. Headline overlap is re-checked
   * each frame because a rising headline moves its box.
   */
  static draw(ctx: SKRSContext2D, prepared: PreparedCreative, t: number, motion?: MotionKind): void {
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

    // Layer 4 — campaign copy, wrapped to the inset-reduced width and centred
    // in the inset rectangle. wrapText uses this ctx so metrics match the blit.
    const headline = layoutHeadline(ctx, prepared);
    const rise = motion === "headline-rise";
    const dy = rise ? (1 - eased) * 0.12 * height : 0;
    const alpha = rise ? eased : 1;
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    if (dy !== 0 || alpha !== 1) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(0, dy);
    }
    let y = headline.firstY;
    for (const line of headline.lines) {
      ctx.fillText(line, headline.centerX, y);
      y += headline.lineHeight;
    }
    if (dy !== 0 || alpha !== 1) {
      ctx.restore();
    }

    // Layer 5 — brand logo, anchored opposite the headline (top-right for a bottom
    // headline, bottom-left for a top headline). Inset offset was captured in
    // prepare; if the (possibly risen) headline block overlaps it, snap to an inset edge.
    const headlineBox = dy === 0 ? headline.box : { ...headline.box, y: headline.box.y + dy };
    if (prepared.logo) {
      const { image, x, width: lw, height: lh } = prepared.logo;
      let ly = prepared.logo.y;
      const logoBox = { x, y: ly, width: lw, height: lh };
      if (boxesOverlap(headlineBox, logoBox)) {
        ly = resolveOverlappingLogoY(prepared, headlineBox, lw, lh, x);
      }
      ctx.drawImage(image, x, ly, lw, lh);
    }
  }

  /** Load background + logo and capture everything {@link NodeCanvasCompositor.draw} needs. */
  static async prepare(
    request: CompositeRequest,
    fontFamily: string = "Inter",
  ): Promise<PreparedCreative> {
    const { width, height } = request.ratio;
    const top = request.layout === "headline-top";
    const subtle = request.tone === "subtle";
    const shadeAlpha = subtle ? 0.4 : 0.7;
    const fontWeight = subtle ? "500" : "bold";
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
        const target = width * 0.16;
        const scale = target / image.width;
        const logoH = image.height * scale;
        const margin = width * 0.04;
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

    return {
      width,
      height,
      top,
      shadeAlpha,
      fontWeight,
      fontFamily,
      message: request.message,
      brandColor: request.brandColor,
      background,
      logo,
      logoApplied,
      insets,
    };
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

function layoutHeadline(ctx: SKRSContext2D, prepared: PreparedCreative): HeadlineLayout {
  const { width, height, top, fontWeight, fontFamily, message, insets } = prepared;
  const innerWidth = width - insets.left - insets.right;
  const wrapWidth = innerWidth * 0.85;
  const centerX = insets.left + innerWidth / 2;
  const originalFontSize = Math.round(width * 0.06);
  const floor = Math.round(originalFontSize * 0.4);

  const trySize = (fontSize: number) => {
    ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}, sans-serif`;
    const lines = wrapText(ctx, message, wrapWidth);
    const lineHeight = fontSize * 1.25;
    const minFirst = insets.top + fontSize;
    const maxLast = height - insets.bottom;
    const span = (lines.length - 1) * lineHeight;
    const fits = minFirst + span <= maxLast;
    let firstY = top
      ? height * 0.1 + fontSize + insets.top
      : height - height * 0.08 - span - insets.bottom;
    if (fits) {
      firstY = Math.min(Math.max(firstY, minFirst), maxLast - span);
    }
    return { lines, fontSize, lineHeight, firstY, fits, minFirst, maxLast, span };
  };

  let fontSize = originalFontSize;
  let attempt = trySize(fontSize);
  while (!attempt.fits && fontSize > floor) {
    fontSize = Math.max(floor, fontSize - 4);
    attempt = trySize(fontSize);
  }

  if (!attempt.fits) {
    const maxLines = Math.max(1, Math.floor((attempt.maxLast - attempt.minFirst) / attempt.lineHeight) + 1);
    let lines = attempt.lines;
    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      lines[lines.length - 1] = ellipsize(ctx, lines[lines.length - 1], wrapWidth);
    }
    const span = (lines.length - 1) * attempt.lineHeight;
    let firstY = top
      ? height * 0.1 + attempt.fontSize + insets.top
      : height - height * 0.08 - span - insets.bottom;
    firstY = Math.min(Math.max(firstY, attempt.minFirst), attempt.maxLast - span);
    attempt = { ...attempt, lines, firstY, span, fits: true };
  }

  return {
    lines: attempt.lines,
    fontSize: attempt.fontSize,
    lineHeight: attempt.lineHeight,
    firstY: attempt.firstY,
    centerX,
    box: {
      x: centerX - wrapWidth / 2,
      y: attempt.firstY - attempt.fontSize,
      width: wrapWidth,
      height: attempt.span + attempt.fontSize,
    },
  };
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
