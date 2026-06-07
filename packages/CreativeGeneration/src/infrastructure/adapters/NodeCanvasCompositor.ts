import { readFile } from "node:fs/promises";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import type {
  CompositeRequest,
  CompositorPort,
} from "@campaignforge/CampaignOrchestration";
import { wrapText } from "./canvas-util.js";

/**
 * NodeCanvasCompositor — CompositorPort adapter.
 *
 * Renders one creative with strict, deterministic layer stacking:
 *   1. background buffer
 *   2. dark bottom gradient (WCAG-legible copy)
 *   3. centred campaign message
 *   4. brand logo, top-right
 */
export class NodeCanvasCompositor implements CompositorPort {
  async compositeAsset(request: CompositeRequest): Promise<Uint8Array> {
    const { width, height } = request.ratio;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    // Layer 1 — background.
    const background = await loadImage(Buffer.from(request.background));
    ctx.drawImage(background, 0, 0, width, height);

    // Layer 2 — dark gradient for contrast.
    const shade = ctx.createLinearGradient(0, height * 0.45, 0, height);
    shade.addColorStop(0, "rgba(0, 0, 0, 0)");
    shade.addColorStop(1, "rgba(0, 0, 0, 0.7)");
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, width, height);

    // Layer 3 — centred campaign copy (wrapped to width).
    const fontSize = Math.round(width * 0.06);
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    const lines = wrapText(ctx, request.message, width * 0.85);
    const lineHeight = fontSize * 1.25;
    let y = height - height * 0.08 - (lines.length - 1) * lineHeight;
    for (const line of lines) {
      ctx.fillText(line, width / 2, y);
      y += lineHeight;
    }

    // Layer 4 — brand logo, anchored top-right (optional).
    try {
      const logo = await loadImage(await readFile(request.logoPath));
      const target = width * 0.16;
      const scale = target / logo.width;
      const margin = width * 0.04;
      ctx.drawImage(logo, width - target - margin, margin, target, logo.height * scale);
    } catch {
      // logo is optional — skip cleanly when the path is missing.
    }

    return canvas.toBuffer("image/png");
  }
}
