import { readFile } from "node:fs/promises";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import type {
  AspectRatio,
  ImageGeneratorPort,
  Product,
} from "@campaignfoundry/CampaignOrchestration";
import { hexToRgb } from "./canvas-util.js";

/**
 * ProceduralBackgroundGenerator — ImageGeneratorPort adapter.
 *
 * Reuses a product's inputAsset when present (cover-fitted to the ratio),
 * otherwise generates a deterministic diagonal gradient from the brand colour.
 * Runs fully offline — this is the exact seam where a GenAI image model plugs in
 * (a sibling adapter behind the same port, no domain change).
 */
export class ProceduralBackgroundGenerator implements ImageGeneratorPort {
  async resolveBackground(product: Product, ratio: AspectRatio): Promise<Uint8Array> {
    if (product.inputAsset) {
      const reused = await this.tryLoadAsset(product.inputAsset, ratio);
      if (reused) return reused;
    }
    return this.generateGradient(product.primaryColor, ratio);
  }

  private async tryLoadAsset(path: string, ratio: AspectRatio): Promise<Uint8Array | undefined> {
    try {
      const image = await loadImage(await readFile(path));
      const canvas = createCanvas(ratio.width, ratio.height);
      const ctx = canvas.getContext("2d");
      const scale = Math.max(ratio.width / image.width, ratio.height / image.height);
      const w = image.width * scale;
      const h = image.height * scale;
      ctx.drawImage(image, (ratio.width - w) / 2, (ratio.height - h) / 2, w, h);
      return canvas.toBuffer("image/png");
    } catch {
      return undefined; // missing / unreadable asset → fall back to generation
    }
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
