import type { AspectRatioValue } from "../value-objects/AspectRatio.vo.js";
import type { BackgroundSource } from "../value-objects/BackgroundSource.vo.js";

/**
 * GeneratedAsset — one rendered creative (a product × aspect-ratio pairing).
 * Identity is the combination of productId and aspectRatio.
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
}
