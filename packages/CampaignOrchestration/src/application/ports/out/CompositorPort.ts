import type { AspectRatio } from "../../../domain/value-objects/AspectRatio.vo.js";

/** A single compositing request — one creative to render. */
export interface CompositeRequest {
  readonly background: Uint8Array;
  /** The resolved campaign copy (localized message or fallback). */
  readonly message: string;
  /** The product's primary brand colour (hex) — rendered as the brand accent. */
  readonly brandColor: string;
  readonly logoPath: string;
  readonly ratio: AspectRatio;
}

/** The rendered creative plus the compositing signals the use case reports. */
export interface CompositeResult {
  /** The rendered PNG bytes. */
  readonly image: Uint8Array;
  /** Whether the brand logo layer was successfully applied (brand-compliance signal). */
  readonly logoApplied: boolean;
}

/**
 * CompositorPort — outbound port: stack visual layers onto a canvas at the
 * ratio's dimensions and return the rendered PNG plus compositing signals.
 * Implemented by CreativeGeneration.
 */
export interface CompositorPort {
  compositeAsset(request: CompositeRequest): Promise<CompositeResult>;
}
