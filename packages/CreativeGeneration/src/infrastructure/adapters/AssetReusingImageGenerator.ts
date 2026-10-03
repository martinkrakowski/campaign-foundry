import { createCanvas, loadImage } from "@napi-rs/canvas";
import type {
  AspectRatio,
  BackgroundContext,
  BackgroundResult,
  ImageGeneratorPort,
  InputAssetPort,
  Product,
} from "@campaignfoundry/CampaignOrchestration";

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
  /** @param inputs the confined reader a reused asset is read through (PT-4c). */
  constructor(
    private readonly generator: ImageGeneratorPort,
    private readonly inputs: InputAssetPort,
  ) {}

  async resolveBackground(
    product: Product,
    ratio: AspectRatio,
    context: BackgroundContext,
  ): Promise<BackgroundResult> {
    if (product.inputAsset) {
      const reused = await this.tryReuseAsset(product.inputAsset, ratio);
      if (reused) return { image: reused, source: "reused" };
    }
    return this.generator.resolveBackground(product, ratio, context);
  }

  /** Cover-fit a supplied asset to the target ratio; undefined if missing/unreadable. */
  private async tryReuseAsset(path: string, ratio: AspectRatio): Promise<Uint8Array | undefined> {
    try {
      const bytes = await this.inputs.read(path);
      // An unsafe ref is indistinguishable from one that was never named, so the
      // read never throws for it — it comes back undefined and falls through here.
      if (bytes === undefined) return undefined;
      const image = await loadImage(Buffer.from(bytes));
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
