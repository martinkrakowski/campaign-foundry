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

/**
 * CompositorPort — outbound port: stack visual layers onto a canvas at the
 * ratio's dimensions and return the rendered PNG bytes. Implemented by
 * CreativeGeneration.
 */
export interface CompositorPort {
  compositeAsset(request: CompositeRequest): Promise<Uint8Array>;
}
