import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { parseBrief } from "../../lib/load-brief.js";
import { ALLOWED_IMAGE_MODELS, runCampaign } from "../../lib/pipeline.js";
import { writeReport } from "../../lib/report.js";

/**
 * POST /campaigns/generate — body is a campaign brief (JSON). An optional `?model=`
 * query selects the primary image model (else the default fallback chain). Runs the
 * pipeline, persists report.json (so GET /campaigns/result reflects it), and returns
 * the assets, halt flag, and execution log.
 */
export default defineEventHandler(async (event) => {
  let brief: CampaignBrief;
  try {
    brief = parseBrief(await readBody(event));
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: error instanceof Error ? error.message : "Invalid campaign brief" };
  }

  // `?model=` is untrusted — only allow the curated model ids, else 400. Without
  // this, any caller could invoke arbitrary OpenRouter models (cost/abuse). An
  // absent param is fine (the default fallback chain).
  const model = getQuery(event).model;
  const imageModel = typeof model === "string" ? model : undefined;
  if (imageModel !== undefined && !ALLOWED_IMAGE_MODELS.includes(imageModel)) {
    setResponseStatus(event, 400);
    return { error: `Unknown image model: ${imageModel}` };
  }

  const result = await runCampaign(brief, imageModel);
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
