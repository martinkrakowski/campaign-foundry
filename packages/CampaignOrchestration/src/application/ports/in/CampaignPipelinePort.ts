import type { CampaignBrief } from "../../../domain/entities/CampaignBrief.js";
import type { PipelineResult } from "../../../domain/value-objects/PipelineResult.vo.js";
import type { Result } from "@campaignforge/shared";

/**
 * CampaignPipelinePort — the single inbound entry-point contract. Every driving
 * adapter (the Nitro route, the CLI) invokes this port and never bypasses it.
 */
export interface CampaignPipelinePort {
  execute(brief: CampaignBrief): Promise<Result<PipelineResult, Error>>;
}
