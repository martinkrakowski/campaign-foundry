import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { parseBrief, parseRegenerateOnly } from "../../lib/load-brief.js";
import { ALLOWED_IMAGE_MODELS, runCampaign } from "../../lib/pipeline.js";
import { writeReport } from "../../lib/report.js";

/**
 * POST /campaigns/generate — runs the pipeline and persists report.json (so GET
 * /campaigns/result reflects it), returning the assets, halt flag, and execution log.
 *
 * Body is either a bare campaign brief, or an envelope `{ brief, regenerateOnly }`
 * where `regenerateOnly` (the HITL re-roll) restricts the run to just those creatives
 * and merges them into the persisted report. An optional `?model=` query selects the
 * primary image model (else the default fallback chain).
 */
export default defineEventHandler(async (event) => {
  let brief: CampaignBrief;
  let regenerateOnly: ReturnType<typeof parseRegenerateOnly>;
  try {
    const body: unknown = await readBody(event);
    // Envelope form carries a `brief` field; a bare brief is the body itself.
    const isEnvelope = typeof body === "object" && body !== null && "brief" in body;
    brief = parseBrief(isEnvelope ? (body as { brief: unknown }).brief : body);
    regenerateOnly = isEnvelope
      ? parseRegenerateOnly((body as { regenerateOnly?: unknown }).regenerateOnly)
      : undefined;
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

  const result = await runCampaign(brief, imageModel, regenerateOnly);
  if (!result.success) {
    setResponseStatus(event, 422);
    return { error: result.error.message };
  }

  // A selective run produced only the regenerated cells — merge them into the
  // persisted report so the full campaign survives a partial run.
  await writeReport(result.value, { merge: regenerateOnly !== undefined });
  return {
    halted: result.value.halted,
    assets: result.value.assets,
    log: result.value.log,
  };
});
