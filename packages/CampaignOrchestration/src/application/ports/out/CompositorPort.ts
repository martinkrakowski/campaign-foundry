import type { CanvasSpec } from "../../../domain/value-objects/aspect-ratios.js";
import type { LayoutKind, ToneKind } from "../../../domain/value-objects/Treatment.vo.js";
import type { AnchorKind } from "../../../domain/value-objects/variation-defaults.js";
import type { Style } from "../../../domain/value-objects/creative-style.js";

/**
 * Platform safe-zone insets in px. All four sides are required when the
 * field is present; omit `safeInsets` (or pass zeros) to keep classic geometry.
 */
export interface SafeInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/** A single compositing request — one creative to render. */
export interface CompositeRequest {
  readonly background: Uint8Array;
  /** The resolved campaign copy (localized message or fallback). */
  readonly message: string;
  /** The product's primary brand colour (hex) — rendered as the brand accent. */
  readonly brandColor: string;
  readonly logoPath: string;
  /**
   * Canvas identity: a social `{ ratio }` or a display `{ size }` (D113).
   * Dimensions come from `resolveCanvas(canvas)` unless `pixelSize` overrides.
   */
  readonly canvas: CanvasSpec;
  /**
   * Pixel override. Production omits it. The video-compositor suite shrinks a
   * 9:16 to 108×192 so 24-frame encodes stay cheap; `prepare` then uses these
   * numbers instead of `resolveCanvas`.
   */
  readonly pixelSize?: { readonly width: number; readonly height: number };
  /** Treatment: where the headline/logo anchor (data-driven, not hardcoded). */
  readonly layout: LayoutKind;
  /** Treatment: visual intensity of the overlay. */
  readonly tone: ToneKind;
  /**
   * Vertical placement of the headline block (T4). Absent → derived from
   * `layout` (`headline-top` → `top`, else `bottom`), which is byte-identical
   * to the pre-axis behaviour. The horizontal edge stays `layout`'s.
   */
  readonly anchor?: AnchorKind;
  /**
   * Platform safe-zone insets in px. All four sides required when present.
   * Absent or all-zero keeps today's geometry (classic callers omit the field).
   */
  readonly safeInsets?: SafeInsets;
  /**
   * The brief's optional creative style (T5): typography every creative of the
   * brief renders with. Absent → the renderer's defaults, byte-identical to
   * the pre-style behaviour (D54). Hashed nowhere — this rides the render
   * request, never the variation policy.
   */
  readonly style?: Style;
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
 * canvas's dimensions and return the rendered PNG plus compositing signals.
 * Implemented by CreativeGeneration.
 */
export interface CompositorPort {
  compositeAsset(request: CompositeRequest): Promise<CompositeResult>;
}
