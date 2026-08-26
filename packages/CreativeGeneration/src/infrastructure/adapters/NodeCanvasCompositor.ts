import { readFile } from "node:fs/promises";
import { createCanvas, loadImage, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import type {
  CompositeRequest,
  CompositeResult,
  CompositorPort,
} from "@campaignfoundry/CampaignOrchestration";
import { hexToRgb, wrapText } from "./canvas-util.js";
import { registerBundledFonts } from "../fonts.js";
import { resolveAssetPath } from "../safe-path.js";

/**
 * Everything {@link drawCreative} needs to blit a still (or a later motion
 * frame). Images and logo geometry are loaded once in {@link NodeCanvasCompositor.prepareCreative};
 * wrapping stays on the real drawing context so measureText matches the blit.
 */
export interface PreparedCreative {
  readonly width: number;
  readonly height: number;
  readonly top: boolean;
  readonly subtle: boolean;
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
}

/**
 * Paint a prepared creative onto `ctx`. `t` is accepted and currently ignored
 * by every layer — `t = 1` is the still's rest pose (motion is a later wave).
 */
export function drawCreative(ctx: SKRSContext2D, prepared: PreparedCreative, t: number): void {
  void t;
  const { width, height, top, shadeAlpha, fontWeight, fontFamily } = prepared;

  // Layer 1 — background.
  ctx.drawImage(prepared.background, 0, 0, width, height);

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
  ctx.fillStyle = `rgb(${ar}, ${ag}, ${ab})`;
  if (top) {
    ctx.fillRect(0, 0, width, solidH);
    const fade = ctx.createLinearGradient(0, solidH, 0, solidH + fadeH);
    fade.addColorStop(0, `rgb(${ar}, ${ag}, ${ab})`);
    fade.addColorStop(1, `rgba(${ar}, ${ag}, ${ab}, 0)`);
    ctx.fillStyle = fade;
    ctx.fillRect(0, solidH, width, fadeH);
  } else {
    ctx.fillRect(0, height - solidH, width, solidH);
    const fade = ctx.createLinearGradient(0, height - solidH - fadeH, 0, height - solidH);
    fade.addColorStop(0, `rgba(${ar}, ${ag}, ${ab}, 0)`);
    fade.addColorStop(1, `rgb(${ar}, ${ag}, ${ab})`);
    ctx.fillStyle = fade;
    ctx.fillRect(0, height - solidH - fadeH, width, fadeH);
  }

  // Layer 4 — campaign copy (wrapped to width), anchored on the headline edge.
  // Bundled font (default "Inter") for machine-independent rendering; weight
  // comes from the treatment's tone. wrapText uses this ctx so metrics match
  // the blit — wrapping is drawing-adjacent, not I/O.
  const fontSize = Math.round(width * 0.06);
  ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}, sans-serif`;
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const lines = wrapText(ctx, prepared.message, width * 0.85);
  const lineHeight = fontSize * 1.25;
  let y = top
    ? height * 0.1 + fontSize // first baseline near the top
    : height - height * 0.08 - (lines.length - 1) * lineHeight; // last baseline near the bottom
  for (const line of lines) {
    ctx.fillText(line, width / 2, y);
    y += lineHeight;
  }

  // Layer 5 — brand logo, anchored opposite the headline (top-right for a bottom
  // headline, bottom-left for a top headline). Geometry was captured in prepare.
  if (prepared.logo) {
    const { image, x, y: ly, width: lw, height: lh } = prepared.logo;
    ctx.drawImage(image, x, ly, lw, lh);
  }
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
 * Still path: {@link prepareCreative} (I/O) → {@link drawCreative} at `t = 1`.
 */
export class NodeCanvasCompositor implements CompositorPort {
  constructor(private readonly fontFamily: string = "Inter") {
    registerBundledFonts();
  }

  /** Load background + logo and capture everything {@link drawCreative} needs. */
  async prepareCreative(request: CompositeRequest): Promise<PreparedCreative> {
    const { width, height } = request.ratio;
    const top = request.layout === "headline-top";
    const subtle = request.tone === "subtle";
    const shadeAlpha = subtle ? 0.4 : 0.7;
    const fontWeight = subtle ? "500" : "bold";

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
        const lx = top ? margin : width - target - margin;
        const ly = top ? height - logoH - margin : margin;
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
      subtle,
      shadeAlpha,
      fontWeight,
      fontFamily: this.fontFamily,
      message: request.message,
      brandColor: request.brandColor,
      background,
      logo,
      logoApplied,
    };
  }

  async compositeAsset(request: CompositeRequest): Promise<CompositeResult> {
    const prepared = await this.prepareCreative(request);
    const canvas = createCanvas(prepared.width, prepared.height);
    const ctx = canvas.getContext("2d");
    drawCreative(ctx, prepared, 1);
    return { image: canvas.toBuffer("image/png"), logoApplied: prepared.logoApplied };
  }
}
