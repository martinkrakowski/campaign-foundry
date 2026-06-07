import type { Product } from "../../../domain/entities/Product.js";
import type { AspectRatio } from "../../../domain/value-objects/AspectRatio.vo.js";

/**
 * ImageGeneratorPort — outbound port: resolve or generate the base background
 * layer for a product at a target aspect ratio. Implemented by CreativeGeneration.
 *
 * When the product carries an inputAsset it is loaded and fitted; otherwise a
 * background is generated. Returns raw image bytes (Uint8Array) — no Node Buffer
 * leaks into the domain.
 */
export interface ImageGeneratorPort {
  resolveBackground(product: Product, ratio: AspectRatio): Promise<Uint8Array>;
}
