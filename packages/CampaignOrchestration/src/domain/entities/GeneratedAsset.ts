import type { AspectRatioValue } from "../value-objects/aspect-ratios.js";
import type { DisplaySize } from "../value-objects/display-sizes.js";
import type { BackgroundSource } from "../value-objects/BackgroundSource.vo.js";
import type { LayoutKind, ToneKind } from "../value-objects/Treatment.vo.js";
import type { MotionKind } from "../value-objects/MotionKind.vo.js";
import type { AnchorKind } from "../value-objects/variation-defaults.js";
import type { BackgroundAxisSource } from "../value-objects/VariationPolicy.vo.js";

/**
 * Fields that identify a creative in a report, grid, or merge.
 *
 * Variation identity is `productId/v<variantIndex>`; classic remains
 * `productId/aspectRatio/treatment` (D6), with a display cell keyed
 * `productId/size/treatment` — a `728x90` cell must not collide with a
 * ratio cell. Presence of `variantIndex` is the discriminator.
 */
export interface AssetIdentity {
  readonly productId: string;
  readonly variantIndex?: number;
  readonly aspectRatio?: string;
  /** The display family's canvas (D113); present only when `aspectRatio` is not. */
  readonly size?: string;
  readonly treatment?: string;
}

/** Stable identity key — classic triple, or `productId/v<index>` in variation mode. */
export function assetIdentity(a: AssetIdentity): string {
  if (a.variantIndex !== undefined) return `${a.productId}/v${a.variantIndex}`;
  const canvas = a.aspectRatio ?? a.size;
  return `${a.productId}/${canvas}/${a.treatment}`;
}

/** Planned-axis snapshot stamped onto variation assets (omitted on classic). */
export interface VariantDescriptor {
  readonly layout: LayoutKind;
  readonly tone: ToneKind;
  readonly backgroundSource: BackgroundAxisSource;
  readonly paletteShift: number;
  /** The pooled headline this slot drew (`headline: pool://copy`); omitted otherwise. */
  readonly headline?: string;
  /** The drawn anchor (`top`/`middle`/`bottom`) when the brief carried the axis; omitted otherwise. */
  readonly anchor?: AnchorKind;
  /** Motion kind — motion variants only. */
  readonly motion?: MotionKind;
  /** Clip length in seconds — motion variants only. */
  readonly durationSec?: number;
  /**
   * How many copy beats the clip sequenced (`copy.timeline`) — motion variants that
   * carried a timeline only. Absent means the legacy single-message path, which is a
   * different statement from `1`: one beat is an authored sequence of length one.
   */
  readonly beats?: number;
}

/**
 * GeneratedAsset — one rendered creative (a product × canvas pairing: a social
 * ratio or a display size, exactly one of the two, D113).
 * Identity is {@link assetIdentity}: classic triple, or product + variantIndex.
 */
export interface GeneratedAsset {
  readonly productId: string;
  /** The social family's canvas. Display-size cells carry `size` instead. */
  readonly aspectRatio?: AspectRatioValue;
  /** The display family's exact pixel unit (D113). Ratio cells omit it. */
  readonly size?: DisplaySize;
  /** Relative path of the saved PNG (the poster, for motion), e.g. "hydra-bottle/1x1.png". */
  readonly outputPath: string;
  /** Relative path of the saved mp4. Motion variants only; static/classic omit it. */
  readonly videoPath?: string;
  /** Relative path of the assembled HTML bundle. HTML units only; others omit it. */
  readonly htmlBundlePath?: string;
  /**
   * Relative path of the HTML unit's required raster fallback rendition (D122).
   * Produced by the existing pipeline so an ad server that wants an image always
   * has one. An HTML asset without it is invalid.
   */
  readonly htmlFallbackPath?: string;
  /** Clip length in seconds. Motion variants only. */
  readonly durationSec?: number;
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
  /** Output format. Variation assets set `"static"`, `"motion"` or `"html"`; classic omits it. */
  readonly format?: "static" | "motion" | "html";
  /** Planned axes for this slot. Variation assets only. */
  readonly descriptor?: VariantDescriptor;
}
