import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { completeJob, createJob, failJob, hasRunningJob, runJob } from "../../lib/jobs.js";
import { parseBrief, parseRegenerateOnly } from "../../lib/load-brief.js";
import { ALLOWED_IMAGE_MODELS, runCampaign } from "../../lib/pipeline.js";
import { writeReport } from "../../lib/report.js";

/**
 * POST /campaigns/generate — validates the brief, starts an in-process run, and
 * returns 202 `{ jobId }` immediately. Poll GET /campaigns/jobs/:id; on success the
 * report is persisted so GET /campaigns/result reflects it.
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

  // One run per campaign at a time: a double-click or a retry after a poll blip must
  // not start a second pipeline writing the same output paths and report.
  if (hasRunningJob(brief.id)) {
    setResponseStatus(event, 409);
    return { error: `A run for campaign "${brief.id}" is already in progress.` };
  }

  const jobId = createJob(brief.id);
  runJob(jobId, async () => {
    const result = await runCampaign(brief, imageModel, regenerateOnly);
    if (!result.success) {
      failJob(jobId, result.error.message);
      return;
    }
    // A selective run produced only the regenerated cells — merge them into the
    // persisted report so the full campaign survives a partial run.
    await writeReport(result.value, { merge: regenerateOnly !== undefined });
    completeJob(jobId, {
      halted: result.value.halted,
      assets: result.value.assets,
      log: result.value.log,
      policyHash: result.value.policyHash,
      seed: result.value.seed,
    });
  });
  setResponseStatus(event, 202);
  return { jobId };
});
