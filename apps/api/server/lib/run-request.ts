import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { completeJob, failJob, progressJob, runJob, startQueuedJob } from "./jobs.js";
import type { parseRegenerateOnly } from "./load-brief.js";
import { runCampaign } from "./pipeline.js";
import { readReport, writeReport } from "./report.js";
import { decodeFireflyPlaintext, runEnvironment, type RunEnvironment } from "./run-environment.js";
import type { TenantContext } from "./tenant.js";
import { getProviderKeyStore } from "./ports/index.js";
import {
  ProviderKeyUnavailableError,
  type ProviderKeyPort,
  type Provider,
} from "./ports/provider-key.port.js";
import type { KeyOwner } from "./ports/usage-store.port.js";

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

async function resolveProviderKey(
  keyStore: ProviderKeyPort,
  provider: Provider,
): Promise<string | undefined> {
  try {
    return await keyStore.open(provider);
  } catch (error) {
    if (error instanceof ProviderKeyUnavailableError) return undefined;
    throw error;
  }
}

/**
 * Resolves each provider's key at execution time (PT-7b3a, D175):
 * the org's active key through `getProviderKeyStore(env).open(provider)` when one exists,
 * else the platform's from `env.providers`.
 *
 * A request never carries a key (it crosses Kafka); a key revoked before the run starts is not used.
 * The file backend never has org keys (its store refuses with ProviderKeyUnavailableError),
 * so it runs on platform keys exactly as today.
 */
export async function overlayOrgKeys(env: RunEnvironment): Promise<RunEnvironment> {
  const keyStore = getProviderKeyStore(env);

  let geminiKey = env.providers.geminiKey;
  let geminiOwner: KeyOwner = env.providers.keyOwners?.gemini ?? "platform";
  let openRouterKey = env.providers.openRouterKey;
  let openRouterOwner: KeyOwner = env.providers.keyOwners?.openrouter ?? "platform";
  let fireflyClientId = env.providers.fireflyClientId;
  let fireflyClientSecret = env.providers.fireflyClientSecret;
  let fireflyOwner: KeyOwner = env.providers.keyOwners?.firefly ?? "platform";

  const orgGemini = await resolveProviderKey(keyStore, "gemini");
  if (orgGemini) {
    geminiKey = orgGemini;
    geminiOwner = "org";
  }

  const orgOpenRouter = await resolveProviderKey(keyStore, "openrouter");
  if (orgOpenRouter) {
    openRouterKey = orgOpenRouter;
    openRouterOwner = "org";
  }

  const orgFirefly = await resolveProviderKey(keyStore, "firefly");
  if (orgFirefly) {
    try {
      const decoded = decodeFireflyPlaintext(orgFirefly);
      fireflyClientId = decoded.clientId;
      fireflyClientSecret = decoded.clientSecret;
      fireflyOwner = "org";
    } catch {
      // Non-JSON plaintext falls back to platform
    }
  }

  const keyOwners = {
    gemini: geminiOwner,
    openrouter: openRouterOwner,
    firefly: fireflyOwner,
  };

  return {
    ...env,
    providers: {
      ...env.providers,
      geminiKey,
      openRouterKey,
      fireflyClientId,
      fireflyClientSecret,
      keyOwners,
    },
  };
}

/**
 * Rebuilds the RunEnvironment from the tenant and executes the campaign generation,
 * including progress reporting, error handling, report fencing, and job completion.
 */
export async function executeRunRequest(request: RunRequest, signal?: AbortSignal): Promise<void> {
  const baseEnv = runEnvironment(request.tenant);
  const env = await overlayOrgKeys(baseEnv);
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

import * as self from "./run-request.js";

/**
 * Shared start-or-drop logic for run delivery (PT-6b1, PT-6b2, D171, D174d).
 * Used by both InProcessRunDelivery and RunConsumer to ensure identical behavior.
 *
 * Resolves the run environment, attempts to claim the queued job via `startQueuedJob`,
 * and if claimed executes `runJob` with `executeRunRequest`.
 *
 * If environment resolution fails, the error is logged and false is returned so caller
 * can safely drop and commit.
 * If `startQueuedJob` rejects (e.g. database down), the error is propagated so it can be retried.
 */
export async function startOrDrop(request: RunRequest): Promise<boolean> {
  let env: RunEnvironment;
  try {
    env = runEnvironment(request.tenant);
  } catch (error) {
    console.warn(
      `[run-delivery] Dropping run request with unresolvable environment for job "${request.jobId}": ${(error as Error).message}`,
    );
    return false;
  }

  const started = await startQueuedJob(env, request.jobId);
  if (!started) {
    console.warn(
      `[run-delivery] Dropping duplicate or expired run request for job "${request.jobId}"`,
    );
    return false;
  }

  runJob(env, request.jobId, (signal) => self.executeRunRequest(request, signal));
  return true;
}
