import type { PipelineResult } from "@campaignfoundry/CampaignOrchestration";

export type JobStatus = "running" | "completed" | "failed";

/** The `{ halted, assets, log }` payload a completed run used to return on POST. */
export interface JobResult {
  halted: boolean;
  assets: PipelineResult["assets"];
  log: PipelineResult["log"];
  policyHash?: string;
  seed?: number;
}

export interface Job {
  status: JobStatus;
  done: number;
  total: number;
  log: PipelineResult["log"] | null;
  result?: JobResult;
  error?: string;
}

/** Most jobs kept in memory; the oldest are evicted first (terminal ones before running). */
export const MAX_JOBS = 50;
/** How long a settled job stays pollable after it completes or fails. */
export const JOB_TTL_MS = 10 * 60_000;

interface Entry {
  campaignId: string;
  job: Job;
}

/**
 * In-process only — a restart empties this map and GET /campaigns/jobs/:id 404s.
 * Bounded two ways so a long-lived API can't grow without limit: a size cap on
 * create, and a TTL that drops settled jobs once the poller has had ample time
 * to read them. A cleared TTL timer is `unref`'d so it never keeps the process up.
 */
const jobs = new Map<string, Entry>();

function evictToFit(): void {
  if (jobs.size < MAX_JOBS) return;
  // Insertion order == age. Evict on every create, so the store is never more than
  // one over: drop the oldest settled job, else the oldest runner.
  for (const [id, entry] of jobs) {
    if (entry.job.status !== "running") {
      jobs.delete(id);
      return;
    }
  }
  jobs.delete(jobs.keys().next().value as string);
}

function expireLater(id: string): void {
  const timer = setTimeout(() => jobs.delete(id), JOB_TTL_MS);
  timer.unref();
}

export function createJob(campaignId: string): string {
  evictToFit();
  const id = crypto.randomUUID();
  jobs.set(id, { campaignId, job: { status: "running", done: 0, total: 0, log: null } });
  return id;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id)?.job;
}

/**
 * The id of the job still running for this campaign, else undefined — the handle a
 * 409 "already in progress" hands back, so the second press can adopt the run that
 * is actually in flight instead of discarding it.
 */
export function getRunningJobId(campaignId: string): string | undefined {
  for (const [id, entry] of jobs) {
    if (entry.campaignId === campaignId && entry.job.status === "running") return id;
  }
  return undefined;
}

/** True while a job for this campaign is still running — one run per campaign at a time. */
export function hasRunningJob(campaignId: string): boolean {
  return getRunningJobId(campaignId) !== undefined;
}

function settle(id: string, job: Job): void {
  const entry = jobs.get(id);
  /* istanbul ignore next -- a job can only settle after createJob; evicted-then-settled is a no-op */
  if (!entry) return;
  entry.job = job;
  expireLater(id);
}

export function completeJob(id: string, payload: JobResult): void {
  const n = payload.halted ? 0 : payload.assets.length;
  settle(id, { status: "completed", done: n, total: n, log: payload.log, result: payload });
}

export function failJob(id: string, error: string): void {
  settle(id, { status: "failed", done: 0, total: 0, log: null, error });
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
      failJob(id, reason instanceof Error ? reason.message : "Job failed");
    }
  })();
}

/** Test seam: forget every job (the map is module state). */
export function resetJobs(): void {
  jobs.clear();
}
