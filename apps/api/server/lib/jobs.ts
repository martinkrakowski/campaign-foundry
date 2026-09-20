import { JOB_TTL_MS } from "./ports/fs-job-store.js";
import { getJobStore } from "./ports/index.js";
import type { Job, JobResult, JobStatus, StoredJob } from "./ports/job-store.port.js";

export type { JobStatus, JobResult, Job, StoredJob };
export { MAX_JOBS, JOB_TTL_MS } from "./ports/fs-job-store.js";

export async function acquireJob(
  campaignId: string,
): Promise<{ acquired: true; jobId: string } | { acquired: false; runningJobId: string }> {
  return getJobStore().acquireJob(campaignId);
}

export async function createJob(campaignId: string): Promise<string> {
  return getJobStore().createJob(campaignId);
}

export async function deleteJob(id: string): Promise<void> {
  return getJobStore().deleteJob(id);
}

export async function getJob(id: string): Promise<Job | undefined> {
  return getJobStore().getJob(id);
}

/**
 * The id of the job still running for this campaign, else undefined — the handle a
 * 409 "already in progress" hands back, so the second press can adopt the run that
 * is actually in flight instead of discarding it.
 */
export async function getRunningJobId(campaignId: string): Promise<string | undefined> {
  return getJobStore().getRunningJobId(campaignId);
}

/** True while a job for this campaign is still running — one run per campaign at a time. */
export async function hasRunningJob(campaignId: string): Promise<boolean> {
  return getJobStore().hasRunningJob(campaignId);
}

export async function completeJob(id: string, payload: JobResult): Promise<void> {
  return getJobStore().completeJob(id, payload);
}

export async function failJob(id: string, error: string): Promise<void> {
  return getJobStore().failJob(id, error);
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

export function runJob(id: string, work: (signal: AbortSignal) => Promise<void>): void {
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
  void (async () => {
    try {
      await work(controller.signal);
    } catch (reason) {
      try {
        await failJob(id, reason instanceof Error ? reason.message : "Job failed");
      } catch {
        await deleteJob(id).catch(() => undefined);
      }
    } finally {
      clearTimeout(timer);
    }
  })();
}

/** Test seam: forget every job. */
export async function resetJobs(): Promise<void> {
  return getJobStore().clear();
}
