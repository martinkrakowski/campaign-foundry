import { getJobStore } from "./ports/index.js";
import type { Job, JobResult, JobStatus, StoredJob } from "./ports/job-store.port.js";

export type { JobStatus, JobResult, Job, StoredJob };
export { MAX_JOBS, JOB_TTL_MS } from "./ports/fs-job-store.js";

export async function createJob(campaignId: string): Promise<string> {
  return getJobStore().createJob(campaignId);
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
export function runJob(id: string, work: () => Promise<void>): void {
  void (async () => {
    try {
      await work();
    } catch (reason) {
      await failJob(id, reason instanceof Error ? reason.message : "Job failed");
    }
  })();
}

/** Test seam: forget every job. */
export async function resetJobs(): Promise<void> {
  return getJobStore().clear();
}
