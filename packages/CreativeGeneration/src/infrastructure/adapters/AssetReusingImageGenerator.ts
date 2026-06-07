import { readFile } from "node:fs/promises";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import type {
  AspectRatio,
  BackgroundContext,
  ImageGeneratorPort,
  Product,
} from "@campaignfoundry/CampaignOrchestration";
import { resolveAssetPath } from "../safe-path.js";

/**
 * AssetReusingImageGenerator — ImageGeneratorPort decorator.
 *
 * Enforces the brief's "reuse input assets when available, generate when missing"
 * rule independently of *how* generation happens. When a product ships an
 * inputAsset it is cover-fitted to the ratio and returned verbatim; otherwise the
 * call delegates to the wrapped generator (procedural gradient or Imagen). This
 * keeps reuse policy in one place and out of every concrete generator.
 */
export class AssetReusingImageGenerator implements ImageGeneratorPort {
  constructor(private readonly generator: ImageGeneratorPort) {}

  async resolveBackground(
    product: Product,
    ratio: AspectRatio,
    context: BackgroundContext,
  ): Promise<Uint8Array> {
    if (product.inputAsset) {
      const reused = await this.tryReuseAsset(product.inputAsset, ratio);
      if (reused) return reused;
    }
    return this.generator.resolveBackground(product, ratio, context);
  }

  /** Cover-fit a supplied asset to the target ratio; undefined if missing/unreadable. */
  private async tryReuseAsset(path: string, ratio: AspectRatio): Promise<Uint8Array | undefined> {
    const safePath = resolveAssetPath(path);
    if (!safePath) return undefined; // unsafe/absolute path → fall through to generation
    try {
      const image = await loadImage(await readFile(safePath));
      const canvas = createCanvas(ratio.width, ratio.height);
      const ctx = canvas.getContext("2d");
      const scale = Math.max(ratio.width / image.width, ratio.height / image.height);
      const w = image.width * scale;
      const h = image.height * scale;
      ctx.drawImage(image, (ratio.width - w) / 2, (ratio.height - h) / 2, w, h);
      return canvas.toBuffer("image/png");
    } catch {
      return undefined; // missing / unreadable asset → fall through to generation
    }
  }
}
