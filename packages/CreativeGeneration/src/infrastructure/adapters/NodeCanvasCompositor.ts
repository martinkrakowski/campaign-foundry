import { readFile } from "node:fs/promises";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import type {
  CompositeRequest,
  CompositeResult,
  CompositorPort,
} from "@campaignfoundry/CampaignOrchestration";
import { hexToRgb, wrapText } from "./canvas-util.js";

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
 */
export class NodeCanvasCompositor implements CompositorPort {
  async compositeAsset(request: CompositeRequest): Promise<CompositeResult> {
    const { width, height } = request.ratio;
    const top = request.layout === "headline-top";
    const subtle = request.tone === "subtle";
    const shadeAlpha = subtle ? 0.4 : 0.7;
    const fontWeight = subtle ? "500" : "bold";

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    // Layer 1 — background.
    const background = await loadImage(Buffer.from(request.background));
    ctx.drawImage(background, 0, 0, width, height);

    // Layer 2 — contrast shade, darkest at the headline edge, fading into the image.
    const shade = top
      ? ctx.createLinearGradient(0, height * 0.55, 0, 0)
      : ctx.createLinearGradient(0, height * 0.45, 0, height);
    shade.addColorStop(0, "rgba(0, 0, 0, 0)");
    shade.addColorStop(1, `rgba(0, 0, 0, ${shadeAlpha})`);
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, width, height);

    // Layer 3 — brand-colour accent band: a solid base flush to the headline edge
    // plus a soft fade into the image. Solid stays opaque in every tone.
    const [ar, ag, ab] = hexToRgb(request.brandColor);
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
    const fontSize = Math.round(width * 0.06);
    ctx.font = `${fontWeight} ${fontSize}px sans-serif`;
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    const lines = wrapText(ctx, request.message, width * 0.85);
    const lineHeight = fontSize * 1.25;
    let y = top
      ? height * 0.1 + fontSize // first baseline near the top
      : height - height * 0.08 - (lines.length - 1) * lineHeight; // last baseline near the bottom
    for (const line of lines) {
      ctx.fillText(line, width / 2, y);
      y += lineHeight;
    }

    // Layer 5 — brand logo, anchored opposite the headline (top-right for a bottom
    // headline, bottom-left for a top headline). Whether it applies is a
    // brand-compliance signal the use case records on the asset.
    let logoApplied = false;
    try {
      const logo = await loadImage(await readFile(request.logoPath));
      const target = width * 0.16;
      const scale = target / logo.width;
      const logoH = logo.height * scale;
      const margin = width * 0.04;
      const lx = top ? margin : width - target - margin;
      const ly = top ? height - logoH - margin : margin;
      ctx.drawImage(logo, lx, ly, target, logoH);
      logoApplied = true;
    } catch {
      // logo is optional — skip cleanly when the path is missing.
    }

    return { image: canvas.toBuffer("image/png"), logoApplied };
  }
}
