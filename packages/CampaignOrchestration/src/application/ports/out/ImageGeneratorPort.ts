import type { Product } from "../../../domain/entities/Product.js";
import type { AspectRatio } from "../../../domain/value-objects/AspectRatio.vo.js";
import type { BackgroundSource } from "../../../domain/value-objects/BackgroundSource.vo.js";

/**
 * Campaign context handed to background generation so adapters (e.g. a GenAI
 * model) can personalize imagery to the message, audience, and market — the
 * pipeline's "relevance" lever. The procedural adapter ignores it.
 */
export interface BackgroundContext {
  readonly campaignMessage: string;
  readonly targetAudience: string;
  readonly targetRegion: string;
  /** Variation-plan seed. GenAI adapters hash it into the background cache key. */
  readonly seed?: number;
  /** Palette shift in hue-circle turns. Applied only by the procedural generator. */
  readonly paletteShift?: number;
}

/** A resolved background plus its provenance (for HITL/telemetry visibility). */
export interface BackgroundResult {
  /** Raw PNG/JPEG bytes. */
  readonly image: Uint8Array;
  /** Where the background came from. */
  readonly source: BackgroundSource;
  /** True when the bytes were served from the seed cache rather than a live call. */
  readonly cached?: boolean;
}

/**
 * ImageGeneratorPort — outbound port: resolve or generate the base background
 * layer for a product at a target aspect ratio. Implemented by CreativeGeneration
 * (procedural, or Google Imagen). Returns the bytes plus their source.
 */
export interface ImageGeneratorPort {
  resolveBackground(
    product: Product,
    ratio: AspectRatio,
    context: BackgroundContext,
  ): Promise<BackgroundResult>;
}
