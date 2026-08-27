import type { Treatment } from "../value-objects/Treatment.vo.js";
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
  /**
   * Optional creative treatments to produce per product × aspect ratio. When
   * absent the use case applies a single DEFAULT_TREATMENT, so existing briefs
   * are unchanged.
   */
  readonly treatments?: readonly Treatment[];
  /**
   * Optional run mode. Absent means classic brief behaviour so existing
   * briefs are unchanged.
   */
  readonly mode?: "brief" | "variation";
  /**
   * Optional variation policy. Unsupported values are rejected at parse
   * time, not here: `headline` accepts only the pool reference `pool://copy`
   * (its texts are resolved at plan time from the approved pool), and
   * motion/duration need the ffmpeg capability.
   */
  readonly variation?: {
    readonly count?: number;
    readonly seed?: number;
    readonly minDistance?: number;
    readonly coverage?: {
      readonly perProduct?: number;
      readonly perRatio?: number;
    };
    readonly axes?: {
      readonly layout?: readonly string[];
      readonly tone?: readonly string[];
      /**
       * The requested aspect-ratio subset (additive). Absent → every ratio,
       * so briefs written before this axis existed are unchanged; the planner
       * still applies its motion narrowing on top of the selection.
       */
      readonly ratio?: readonly string[];
      readonly background?: { readonly source?: readonly string[] };
      readonly paletteShift?: readonly number[];
      readonly headline?: string;
      readonly motion?: readonly string[];
      readonly duration?: readonly number[];
    };
  };
  /**
   * Optional output request. Absent formats keep today's static pipeline.
   */
  readonly output?: {
    readonly formats?: readonly string[];
    readonly platforms?: readonly string[];
  };
}
