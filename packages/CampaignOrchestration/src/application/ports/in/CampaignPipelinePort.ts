import type { CampaignBrief } from "../../../domain/entities/CampaignBrief.js";
import type { PipelineResult } from "../../../domain/value-objects/PipelineResult.vo.js";
import type { Result } from "@campaignfoundry/shared";

/**
 * A single creative cell to regenerate, addressed by its identity within the
 * campaign matrix (product × aspect ratio × treatment). Mirrors the asset key the
 * review UI uses, so a human's "reject" maps straight to a regeneration target.
 */
export interface RegenerationTarget {
  readonly productId: string;
  readonly aspectRatio: string;
  readonly treatment: string;
}

/** Optional run modifiers passed alongside a brief. */
export interface CampaignExecutionOptions {
  /**
   * When present, only these creatives are (re)generated; every other cell is
   * skipped. Used by the HITL loop to re-roll just the rejected creatives without
   * disturbing approved ones. Absent → full campaign run (every cell).
   */
  readonly regenerateOnly?: ReadonlyArray<RegenerationTarget>;
}

/**
 * CampaignPipelinePort — the single inbound entry-point contract. Every driving
 * adapter (the Nitro route, the CLI) invokes this port and never bypasses it.
 */
export interface CampaignPipelinePort {
  execute(
    brief: CampaignBrief,
    options?: CampaignExecutionOptions,
  ): Promise<Result<PipelineResult, Error>>;
}
