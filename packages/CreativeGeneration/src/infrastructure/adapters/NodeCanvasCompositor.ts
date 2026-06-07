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
 * Renders one creative with strict, deterministic layer stacking:
 *   1. background buffer
 *   2. dark bottom gradient (WCAG-legible copy)
 *   3. brand-colour accent footer (on-brand presence + compliance anchor)
 *   4. centred campaign message
 *   5. brand logo, top-right
 */
export class NodeCanvasCompositor implements CompositorPort {
  async compositeAsset(request: CompositeRequest): Promise<CompositeResult> {
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

    // Layer 3 — brand-colour accent footer: a solid base band with a soft
    // gradient fade above it. Guarantees the brand colour has a meaningful
    // on-brand presence in every creative (~5% pixel density), which is also
    // what the brand-density compliance gate measures.
    const [ar, ag, ab] = hexToRgb(request.brandColor);
    const solidTop = height * 0.95;
    const fadeTop = height * 0.89;
    const accent = ctx.createLinearGradient(0, fadeTop, 0, solidTop);
    accent.addColorStop(0, `rgba(${ar}, ${ag}, ${ab}, 0)`);
    accent.addColorStop(1, `rgb(${ar}, ${ag}, ${ab})`);
    ctx.fillStyle = accent;
    ctx.fillRect(0, fadeTop, width, solidTop - fadeTop);
    ctx.fillStyle = `rgb(${ar}, ${ag}, ${ab})`;
    ctx.fillRect(0, solidTop, width, height - solidTop);

    // Layer 4 — centred campaign copy (wrapped to width).
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

    // Layer 5 — brand logo, anchored top-right (optional). Whether it applies is
    // a brand-compliance signal the use case records on the asset.
    let logoApplied = false;
    try {
      const logo = await loadImage(await readFile(request.logoPath));
      const target = width * 0.16;
      const scale = target / logo.width;
      const margin = width * 0.04;
      ctx.drawImage(logo, width - target - margin, margin, target, logo.height * scale);
      logoApplied = true;
    } catch {
      // logo is optional — skip cleanly when the path is missing.
    }

    return { image: canvas.toBuffer("image/png"), logoApplied };
  }
}
