import type { AspectRatioValue } from "../value-objects/AspectRatio.vo.js";
import type { BackgroundSource } from "../value-objects/BackgroundSource.vo.js";
import type { LayoutKind, ToneKind } from "../value-objects/Treatment.vo.js";
import type { BackgroundAxisSource } from "../value-objects/VariationPolicy.vo.js";

/**
 * Fields that identify a creative in a report, grid, or merge.
 *
 * Variation identity is `productId/v<variantIndex>`; classic remains
 * `productId/aspectRatio/treatment` (D6). Presence of `variantIndex` is the discriminator.
 */
export interface AssetIdentity {
  readonly productId: string;
  readonly variantIndex?: number;
  readonly aspectRatio?: string;
  readonly treatment?: string;
}

/** Stable identity key — classic triple, or `productId/v<index>` in variation mode. */
export function assetIdentity(a: AssetIdentity): string {
  if (a.variantIndex !== undefined) return `${a.productId}/v${a.variantIndex}`;
  return `${a.productId}/${a.aspectRatio}/${a.treatment}`;
}

/** Planned-axis snapshot stamped onto variation assets (omitted on classic). */
export interface VariantDescriptor {
  readonly layout: LayoutKind;
  readonly tone: ToneKind;
  readonly backgroundSource: BackgroundAxisSource;
  readonly paletteShift: number;
}

/**
 * GeneratedAsset — one rendered creative (a product × aspect-ratio pairing).
 * Identity is {@link assetIdentity}: classic triple, or product + variantIndex.
 */
export interface GeneratedAsset {
  readonly productId: string;
  readonly aspectRatio: AspectRatioValue;
  /** Relative path of the saved PNG, e.g. "hydra-bottle/1x1.png". */
  readonly outputPath: string;
  /** Relative path of the print-proof PDF, when one was generated. */
  readonly proofPath?: string;
  /** Brand-colour pixel-density score in the range 0..1. */
  readonly complianceScore: number;
  readonly passedCompliance: boolean;
  /**
   * Raw signal — whether the product logo was present and applied to this asset.
   * Not a compliance verdict on its own; combine with `passedCompliance` (e.g.
   * report.json derives `brandCompliant = passedCompliance && logoApplied`).
   */
  readonly logoApplied: boolean;
  /** The creative treatment id this asset was rendered with (e.g. "default", "subtle-top"). */
  readonly treatment: string;
  /** Provenance of the background layer (Imagen / procedural fallback / reused asset). */
  readonly backgroundSource: BackgroundSource;
  /**
   * Variation-plan slot. Present only on variation assets so classic JSON
   * fixtures stay byte-identical (optional fields omit from serialization).
   */
  readonly variantIndex?: number;
  /**
   * Re-roll counter. Variation originals are `0`; each replan request is
   * `previous + 1`. Omitted on classic assets so report JSON stays byte-identical.
   */
  readonly attempt?: number;
  /** Provenance seed from the plan. Variation assets only. */
  readonly seed?: number;
  /** Output format. Variation assets set `"static"`; classic omits it. */
  readonly format?: "static";
  /** Planned axes for this slot. Variation assets only. */
  readonly descriptor?: VariantDescriptor;
}
