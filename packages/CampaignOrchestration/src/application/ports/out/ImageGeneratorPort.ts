import type { Product } from "../../../domain/entities/Product.js";
import type { AspectRatio } from "../../../domain/value-objects/AspectRatio.vo.js";

/**
 * Campaign context handed to background generation so adapters (e.g. a GenAI
 * model) can personalize imagery to the message, audience, and market — the
 * pipeline's "relevance" lever. The procedural adapter ignores it.
 */
export interface BackgroundContext {
  readonly campaignMessage: string;
  readonly targetAudience: string;
  readonly targetRegion: string;
}

/**
 * ImageGeneratorPort — outbound port: resolve or generate the base background
 * layer for a product at a target aspect ratio. Implemented by CreativeGeneration
 * (procedural, or Google Imagen). Returns raw PNG/JPEG bytes as Uint8Array.
 */
export interface ImageGeneratorPort {
  resolveBackground(product: Product, ratio: AspectRatio, context: BackgroundContext): Promise<Uint8Array>;
}
