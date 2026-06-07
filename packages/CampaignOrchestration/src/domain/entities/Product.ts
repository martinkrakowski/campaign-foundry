/**
 * Product — child entity owned by the {@link CampaignBrief} aggregate.
 * One creative set (across every aspect ratio) is produced per product.
 */
export interface Product {
  readonly id: string;
  readonly name: string;
  /** Brand colour as a hex string, e.g. "#1473E6". Drives procedural backgrounds and brand-compliance scoring. */
  readonly primaryColor: string;
  /** Path to the brand logo, composited onto every creative. */
  readonly logoPath: string;
  /** Optional pre-existing background asset; reused when present, otherwise a background is generated. */
  readonly inputAsset?: string;
}
