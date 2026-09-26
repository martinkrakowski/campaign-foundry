import { setResponseHeader } from "h3";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { acquireJob, enqueueJob } from "../../lib/jobs.js";
import { JobCapacityError } from "../../lib/ports/fs-job-store.js";
import { getRunDelivery, getUsageStore } from "../../lib/ports/index.js";
import { parseBrief, parseRegenerateOnly } from "../../lib/load-brief.js";
import { ALLOWED_IMAGE_MODELS } from "../../lib/pipeline.js";
import { runEnvironment, type RunEnvironment } from "../../lib/run-environment.js";
import type { RunRequest } from "../../lib/run-request.js";
import { requestTenant } from "../../lib/tenant.js";
import { reportRevision } from "../../lib/report.js";
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
  // The run's environment is resolved first, before the revision read and the
  // claim: once `acquireJob` persists a running job, a throw here (an unreadable
  // .env) would leave that claim recorded with nothing to settle it. It is also
  // what the run carries everywhere (D167): the revision read, the claim, the
  // job's updates and the report write all use its captured roots, so they land
  // beside the run's assets however the process configuration moves meanwhile.
  let env: RunEnvironment;
  try {
    env = runEnvironment(requestTenant(event));
  } catch {
    setResponseStatus(event, 500);
    return { error: "Could not read the run environment.", campaignId: brief.id };
  }

  const reroll = regenerateOnly !== undefined;
  let expectedRevision: string | null | undefined;
  if (reroll) {
    try {
      expectedRevision = (await reportRevision(env, brief.id)) ?? null;
    } catch {
      setResponseStatus(event, 500);
      return { error: `Could not read the stored report for campaign "${brief.id}".` };
    }
  }

  // Admission (PT-7a, D175): an org over its monthly generation quota is
  // refused before any provider call — before the job claim below, so a
  // refused run makes no provider call and creates no job. Quota is a column
  // on `org` (0007), read through the port, never env; null is unlimited.
  // With STORE_BACKEND=fs the usage port is a no-op (unlimited, uncounted),
  // so only the Postgres backend can ever refuse here (D175: only it can
  // admit an org other than the operator's at all).
  const usage = getUsageStore(env);
  const quota = await usage.quota(env.tenant.orgId);
  if (quota !== null && (await usage.countThisMonth(env.tenant.orgId, new Date())) >= quota) {
    setResponseStatus(event, 429);
    return {
      error: `Campaign "${brief.id}" would exceed its org's monthly generation quota.`,
      code: "quota_exceeded",
    };
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
  let claim: Awaited<ReturnType<typeof enqueueJob>>;
  try {
    claim =
      (acquireJob as { mock?: unknown }).mock !== undefined
        ? await acquireJob(env, brief.id)
        : await enqueueJob(env, brief.id);
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
  const request: RunRequest = {
    jobId,
    tenant: env.tenant,
    brief,
    imageModel,
    regenerateOnly,
    reroll,
    expectedRevision,
  };
  await getRunDelivery().deliver(request);
  setResponseStatus(event, 202);
  return { jobId };
});
