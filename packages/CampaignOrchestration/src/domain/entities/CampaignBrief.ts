import type { Product } from "./Product.js";

/**
 * CampaignBrief — aggregate root. The unit of work for a single campaign run:
 * it owns the product collection and the campaign copy.
 *
 * Invariants (e.g. "at least two products") are enforced by the use case's
 * ValidateBriefIntegrity step, before any port is called.
 */
export interface CampaignBrief {
  readonly id: string;
  readonly targetRegion: string;
  readonly targetAudience: string;
  readonly campaignMessage: string;
  /** Optional localized copy; the use case falls back to campaignMessage when this is absent. */
  readonly localizedMessage?: string;
  readonly products: readonly Product[];
}
