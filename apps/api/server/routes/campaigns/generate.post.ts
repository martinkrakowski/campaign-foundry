import type { CampaignBrief } from "@campaignforge/CampaignOrchestration";
import { parseBrief } from "../../lib/load-brief.js";
import { runCampaign } from "../../lib/pipeline.js";

/**
 * POST /campaigns/generate — body is a campaign brief (JSON).
 * Returns the generated assets, the halt flag, and the execution log.
 * (`defineEventHandler`, `readBody`, `setResponseStatus` are auto-imported by Nitro.)
 */
export default defineEventHandler(async (event) => {
  let brief: CampaignBrief;
  try {
    brief = parseBrief(await readBody(event));
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: error instanceof Error ? error.message : "Invalid campaign brief" };
  }

  const result = await runCampaign(brief);
  if (!result.success) {
    setResponseStatus(event, 422);
    return { error: result.error.message };
  }

  return {
    halted: result.value.halted,
    assets: result.value.assets,
    log: result.value.log,
  };
});
