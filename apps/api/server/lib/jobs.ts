import { JOB_TTL_MS } from "./ports/fs-job-store.js";
import { getJobStore } from "./ports/index.js";
import { LOCAL_TENANT, type TenantContext } from "./tenant.js";
import type { Job, JobResult, JobStatus, StoredJob } from "./ports/job-store.port.js";

export type { JobStatus, JobResult, Job, StoredJob };
export { MAX_JOBS, JOB_TTL_MS } from "./ports/fs-job-store.js";

export async function acquireJob(
  tenant: TenantContext,
  campaignId: string,
): Promise<{ acquired: true; jobId: string } | { acquired: false; runningJobId: string }> {
  return getJobStore(tenant).acquireJob(campaignId);
}

export async function createJob(tenant: TenantContext, campaignId: string): Promise<string> {
  return getJobStore(tenant).createJob(campaignId);
}

export async function deleteJob(tenant: TenantContext, id: string): Promise<void> {
  return getJobStore(tenant).deleteJob(id);
}

export async function getJob(tenant: TenantContext, id: string): Promise<Job | undefined> {
  return getJobStore(tenant).getJob(id);
}

/**
 * The id of the job still running for this campaign, else undefined — the handle a
 * 409 "already in progress" hands back, so the second press can adopt the run that
 * is actually in flight instead of discarding it.
 */
export async function getRunningJobId(
  tenant: TenantContext,
  campaignId: string,
): Promise<string | undefined> {
  return getJobStore(tenant).getRunningJobId(campaignId);
}

/** True while a job for this campaign is still running — one run per campaign at a time. */
export async function hasRunningJob(tenant: TenantContext, campaignId: string): Promise<boolean> {
  return getJobStore(tenant).hasRunningJob(campaignId);
}

/**
 * Record how far a running job has got. Advisory — a settled job keeps the
 * counts its settlement wrote (see `JobStorePort.progressJob`).
 */
export async function progressJob(
  tenant: TenantContext,
  id: string,
  done: number,
  total: number,
): Promise<void> {
  return getJobStore(tenant).progressJob(id, done, total);
}

export async function completeJob(
  tenant: TenantContext,
  id: string,
  payload: JobResult,
): Promise<void> {
  return getJobStore(tenant).completeJob(id, payload);
}

export async function failJob(tenant: TenantContext, id: string, error: string): Promise<void> {
  return getJobStore(tenant).failJob(id, error);
}

/**
 * Run `work` without blocking the caller. Rejections become status `"failed"`
 * rather than unhandled rejections — the POST has already returned 202.
 */
/**
 * A whole run's ceiling (R5, D77).
 *
 * Matched to `JOB_TTL_MS` on purpose: that is how long a settled job stays
 * observable, so a run permitted to outlive it could finish into a job nobody
 * can read. The per-request ceiling inside each adapter is a different and
 * much shorter bound — this one exists so a run made of many well-behaved
 * requests still cannot run forever.
 */
export const RUN_DEADLINE_MS = JOB_TTL_MS;

export function runJob(
  tenant: TenantContext,
  id: string,
  work: (signal: AbortSignal) => Promise<void>,
): void {
  // The deadline belongs here rather than inside the pipeline: this is the
  // scope that owns the job slot, and D73's whole point is that the slot must
  // come back.
  //
  // A controller with a cleared timer rather than `AbortSignal.timeout`, for two
  // reasons. A run that finishes in thirty seconds should not leave a ten-minute
  // timer alive behind it - `expireLater` in the store already clears its timers
  // for the same reason. And `AbortSignal.timeout` schedules on a timer no test
  // can advance, so the deadline would have been unobservable: the only thing
  // left to assert would be the constant, which is not the behaviour.
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Run deadline exceeded")),
    RUN_DEADLINE_MS,
  );
  timer.unref();
  // The deadline must be TERMINAL, and aborting the signal alone is not.
  // Every image adapter has a fallback, so an aborted provider call degrades to
  // the procedural generator and RESOLVES - the run then carries on compositing,
  // writing files and exporting proofs, and can complete successfully long after
  // it expired. Racing the work against the abort is what actually settles the
  // job, which is the whole reason R1 may refuse to evict a runner.
  //
  // The work itself cannot be killed; it is left to unwind on its own. What
  // matters here is that the SLOT comes back on time.
  const expired = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      // No `??` fallback: `abort` above is always called with an Error, so a
      // default here would be a branch no input can take - the kind the
      // coverage gate exists to surface.
      () => reject(controller.signal.reason as Error),
      { once: true },
    );
  });
  // The loser of the race stays pending; without this an abort that arrives
  // after the work has already finished would surface as an unhandled rejection.
  expired.catch(() => undefined);
  void (async () => {
    try {
      await Promise.race([work(controller.signal), expired]);
    } catch (reason) {
      try {
        await failJob(tenant, id, reason instanceof Error ? reason.message : "Job failed");
      } catch {
        await deleteJob(tenant, id).catch(() => undefined);
      }
    } finally {
      clearTimeout(timer);
    }
  })();
}

/** Test seam: forget every job the local operator's store holds. */
export async function resetJobs(): Promise<void> {
  return getJobStore(LOCAL_TENANT).clear();
}
