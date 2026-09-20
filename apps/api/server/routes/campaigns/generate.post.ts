import { setResponseHeader } from "h3";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { acquireJob, completeJob, failJob, runJob } from "../../lib/jobs.js";
import { JobCapacityError } from "../../lib/ports/fs-job-store.js";
import { parseBrief, parseRegenerateOnly } from "../../lib/load-brief.js";
import { outputRoot } from "../../lib/config.js";
import { ALLOWED_IMAGE_MODELS, runCampaign } from "../../lib/pipeline.js";
import { readReport, reportRevision, writeReport } from "../../lib/report.js";
import {
  NOT_PROBED_REASON,
  PROBE_PENDING_ERROR,
  waitForCapabilities,
} from "../../lib/capabilities.js";

/**
 * POST /campaigns/generate — validates the brief, starts an in-process run, and
 * returns 202 `{ jobId }` immediately. Poll GET /campaigns/jobs/:id; on success the
 * report is persisted so GET /campaigns/result reflects it.
 *
 * Body is either a bare campaign brief, or an envelope `{ brief, regenerateOnly }`
 * where `regenerateOnly` (the HITL re-roll) restricts the run to just those creatives
 * and merges them into the persisted report. A variation re-roll is pinned to the
 * persisted report's `policyHash`: if the pool or policy changed since that run the
 * job fails ("Plan changed since the last run …") instead of overlaying one slot onto
 * a different base plan. An optional `?model=` query selects the primary image model
 * (else the default fallback chain). A run arriving before the boot capability probe
 * settles waits for it (bounded by the probe's own timeout); if the probe still has
 * not landed the answer is 503 with a retry hint — never a 400 that reads as an
 * invalid brief.
 */

/** The persisted report's policyHash for a variation re-roll, else undefined (no pin). */
async function persistedPolicyHash(
  brief: CampaignBrief,
  reroll: boolean,
): Promise<string | undefined> {
  if (!reroll || brief.mode !== "variation") return undefined;
  const report = await readReport(outputRoot(), brief.id);
  const hash =
    typeof report === "object" && report !== null
      ? (report as { policyHash?: unknown }).policyHash
      : undefined;
  return typeof hash === "string" ? hash : undefined;
}

/**
 * The persisted report's copy hash (§35) for a variation re-roll, else undefined
 * (no pin) — same shape as `persistedPolicyHash`, read from the same report. A
 * report persisted before this field existed has no `copyHash` key, so this
 * returns `undefined` for it too: the first re-roll of such a report is not
 * pinned on copy, by the same "absent hash is no pin" rule `persistedPolicyHash`
 * already follows.
 */
async function persistedCopyHash(
  brief: CampaignBrief,
  reroll: boolean,
): Promise<string | undefined> {
  if (!reroll || brief.mode !== "variation") return undefined;
  const report = await readReport(outputRoot(), brief.id);
  const hash =
    typeof report === "object" && report !== null
      ? (report as { copyHash?: unknown }).copyHash
      : undefined;
  return typeof hash === "string" ? hash : undefined;
}
export default defineEventHandler(async (event) => {
  const capabilities = await waitForCapabilities();
  if (capabilities.reason === NOT_PROBED_REASON) {
    setResponseStatus(event, 503);
    setHeader(event, "retry-after", 1);
    return { error: PROBE_PENDING_ERROR };
  }
  let brief: CampaignBrief;
  let regenerateOnly: ReturnType<typeof parseRegenerateOnly>;
  try {
    const body: unknown = await readBody(event);
    // Envelope form carries a `brief` field; a bare brief is the body itself.
    const isEnvelope = typeof body === "object" && body !== null && "brief" in body;
    brief = parseBrief(isEnvelope ? (body as { brief: unknown }).brief : body, {
      enforceCapabilities: true,
      capabilities,
    });
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

  // A re-roll is a read-modify-write over the persisted report: it read this campaign's
  // report when the run was accepted (the same read the policy-hash pin comes from) and
  // overlays its cells onto it when the run lands. So it carries the revision it started
  // from and is refused with ECONFLICT if that report moved meanwhile — a second re-roll
  // no longer silently replaces the first. A full run replaces the report outright and
  // folds nothing in, so it writes unconditionally.
  //
  // The revision is read before the job is claimed, not inside `runJob` and not after
  // `acquireJob`: `reportRevision` rethrows everything that is not ENOENT (a report
  // nobody can read is not "nothing stored"), and once the job is persisted that
  // rejection leaves it recorded and "running" — a claim no later request for this
  // campaign could ever clear. Read first, the same failure is a 500 and leaves
  // nothing behind.
  //
  // `null` when no report is stored: `undefined` is what a caller that wants no check
  // passes, so an absent report has to be its own value or a run that started with none
  // would overwrite one that appeared while it was running.
  const reroll = regenerateOnly !== undefined;
  let expectedRevision: string | null | undefined;
  if (reroll) {
    try {
      expectedRevision = (await reportRevision(outputRoot(), brief.id)) ?? null;
    } catch {
      setResponseStatus(event, 500);
      return { error: `Could not read the stored report for campaign "${brief.id}".` };
    }
  }

  // One run per campaign at a time: a double-click or a retry after a poll blip must
  // not start a second pipeline writing the same output paths and report. The 409
  // carries the running job's handle (`jobId`) so the second press can adopt the run
  // in progress and keep polling it — the pipeline really is running, and discarding
  // it threw away a campaign that succeeded.
  // A full queue is a capacity answer, not an internal error: every slot is a
  // live run, so there is nothing to retire (R1). 503 with Retry-After, because
  // the caller should try again rather than treat it as a broken server - the
  // one thing it must NOT do is what the old code did, which was delete somebody
  // else's running campaign to make room.
  let claim: Awaited<ReturnType<typeof acquireJob>>;
  try {
    claim = await acquireJob(brief.id);
  } catch (error) {
    if (error instanceof JobCapacityError) {
      setResponseStatus(event, 503);
      setResponseHeader(event, "retry-after", 30);
      return { error: error.message, campaignId: brief.id };
    }
    throw error;
  }
  if (!claim.acquired) {
    setResponseStatus(event, 409);
    return {
      error: `A run for campaign "${brief.id}" is already in progress.`,
      jobId: claim.runningJobId,
      campaignId: brief.id,
    };
  }

  const jobId = claim.jobId;
  runJob(jobId, async (signal) => {
    const expectedPolicyHash = await persistedPolicyHash(brief, reroll);
    const expectedCopyHash = await persistedCopyHash(brief, reroll);
    const result = await runCampaign(
      brief,
      imageModel,
      regenerateOnly,
      expectedPolicyHash,
      expectedCopyHash,
      signal,
    );
    if (!result.success) {
      await failJob(jobId, result.error.message);
      return;
    }
    // A selective run produced only the regenerated cells — merge them into the
    // persisted report so the full campaign survives a partial run. `runJob` fails the
    // job with the message if the merge is refused.
    await writeReport(result.value, { merge: reroll, expectedRevision });
    await completeJob(jobId, {
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
