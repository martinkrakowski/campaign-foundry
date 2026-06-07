import { createCanvas } from "@napi-rs/canvas";
import type {
  AspectRatio,
  BackgroundContext,
  BackgroundResult,
  ImageGeneratorPort,
  Product,
} from "@campaignfoundry/CampaignOrchestration";
import { hexToRgb } from "./canvas-util.js";

/**
 * ProceduralBackgroundGenerator — ImageGeneratorPort adapter.
 *
 * Generates a deterministic diagonal gradient from the product's brand colour.
 * Runs fully offline — the GenAI-free default and the graceful fallback. Reuse of
 * a product's inputAsset is handled upstream by AssetReusingImageGenerator, so
 * this adapter has one job: synthesize a background.
 */
export class ProceduralBackgroundGenerator implements ImageGeneratorPort {
  async resolveBackground(
    product: Product,
    ratio: AspectRatio,
    _context: BackgroundContext,
  ): Promise<BackgroundResult> {
    return { image: this.generateGradient(product.primaryColor, ratio), source: "procedural" };
  }

  private generateGradient(primaryColor: string, ratio: AspectRatio): Uint8Array {
    const canvas = createCanvas(ratio.width, ratio.height);
    const ctx = canvas.getContext("2d");
    const [r, g, b] = hexToRgb(primaryColor);
    const gradient = ctx.createLinearGradient(0, 0, ratio.width, ratio.height);
    gradient.addColorStop(0, `rgb(${r}, ${g}, ${b})`);
    gradient.addColorStop(
      1,
      `rgb(${Math.round(r * 0.35)}, ${Math.round(g * 0.35)}, ${Math.round(b * 0.35)})`,
    );
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, ratio.width, ratio.height);
    return canvas.toBuffer("image/png");
  }
}
