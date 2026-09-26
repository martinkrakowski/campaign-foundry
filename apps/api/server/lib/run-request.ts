import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { completeJob, failJob, progressJob } from "./jobs.js";
import type { parseRegenerateOnly } from "./load-brief.js";
import { runCampaign } from "./pipeline.js";
import { readReport, writeReport } from "./report.js";
import { runEnvironment, type RunEnvironment } from "./run-environment.js";
import type { TenantContext } from "./tenant.js";

/**
 * A serialisable run request (PT-6b1, D171, D174d).
 * Captures all parameters needed to execute a campaign run so the request
 * can be delivered in-process or across a message boundary (such as Kafka).
 */
export interface RunRequest {
  readonly jobId: string;
  readonly tenant: TenantContext;
  readonly brief: CampaignBrief;
  readonly imageModel?: string;
  readonly regenerateOnly?: ReturnType<typeof parseRegenerateOnly>;
  readonly reroll: boolean;
  readonly expectedRevision?: string | null;
}

/** The persisted report's policyHash for a variation re-roll, else undefined (no pin). */
async function persistedPolicyHash(
  env: RunEnvironment,
  brief: CampaignBrief,
  reroll: boolean,
): Promise<string | undefined> {
  if (!reroll || brief.mode !== "variation") return undefined;
  const report = await readReport(env, brief.id);
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
  env: RunEnvironment,
  brief: CampaignBrief,
  reroll: boolean,
): Promise<string | undefined> {
  if (!reroll || brief.mode !== "variation") return undefined;
  const report = await readReport(env, brief.id);
  const hash =
    typeof report === "object" && report !== null
      ? (report as { copyHash?: unknown }).copyHash
      : undefined;
  return typeof hash === "string" ? hash : undefined;
}

/**
 * Rebuilds the RunEnvironment from the tenant and executes the campaign generation,
 * including progress reporting, error handling, report fencing, and job completion.
 */
export async function executeRunRequest(request: RunRequest, signal?: AbortSignal): Promise<void> {
  const env = runEnvironment(request.tenant);
  const { jobId, brief, imageModel, regenerateOnly, reroll, expectedRevision } = request;
  const expectedPolicyHash = await persistedPolicyHash(env, brief, reroll);
  const expectedCopyHash = await persistedCopyHash(env, brief, reroll);
  const result = await runCampaign(
    env,
    brief,
    imageModel,
    regenerateOnly,
    expectedPolicyHash,
    expectedCopyHash,
    signal,
    // The tick is synchronous and the store is not, so the write is queued
    // rather than awaited — the pipeline must not stall on a job file. Order
    // survives anyway: `progressJob` runs inside the store's per-id lock
    // chain, which settles calls in the order they were made. A failed write
    // is dropped on purpose: progress is advisory, and a run that finished
    // must not be failed by a counter that could not be persisted.
    (done, total) => {
      void progressJob(env, jobId, done, total).catch(() => undefined);
    },
  );
  if (!result.success) {
    await failJob(env, jobId, result.error.message);
    return;
  }
  // A selective run produced only the regenerated cells — merge them into the
  // persisted report so the full campaign survives a partial run. `runJob` fails the
  // job with the message if the merge is refused.
  await writeReport(env, result.value, {
    merge: reroll,
    expectedRevision,
    fence: { runId: jobId },
  });
  await completeJob(env, jobId, {
    halted: result.value.halted,
    assets: result.value.assets,
    log: result.value.log,
    policyHash: result.value.policyHash,
    seed: result.value.seed,
  });
}
