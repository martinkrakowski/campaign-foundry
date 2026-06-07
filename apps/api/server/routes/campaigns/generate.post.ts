import type { CampaignBrief } from "@campaignforge/CampaignOrchestration";
import { parseBrief } from "../../lib/load-brief.js";
import { runCampaign } from "../../lib/pipeline.js";
import { writeReport } from "../../lib/report.js";

/**
 * POST /campaigns/generate — body is a campaign brief (JSON). Runs the pipeline,
 * persists report.json (so GET /campaigns/result reflects it), and returns the
 * assets, halt flag, and execution log.
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

  await writeReport(result.value);
  return {
    halted: result.value.halted,
    assets: result.value.assets,
    log: result.value.log,
  };
});
