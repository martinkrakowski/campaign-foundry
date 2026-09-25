import type { PipelineResult } from "@campaignfoundry/CampaignOrchestration";

export type JobStatus = "running" | "completed" | "failed";

/** The `{ halted, assets, log }` payload a completed run returns. */
export interface JobResult {
  halted: boolean;
  assets: PipelineResult["assets"];
  log: PipelineResult["log"] | null;
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

/**
 * A job as persisted in storage with its metadata.
 */
export interface StoredJob {
  readonly id: string;
  readonly campaignId: string;
  readonly job: Job;
  readonly createdAt: number;
  readonly seq: number;
  readonly settledAt?: number;
}

/**
 * Port for creating, retrieving, updating, and managing generation jobs.
 *
 * This port is the boundary between the HTTP routes / application layer and
 * the underlying storage mechanism (filesystem today, Redis/database next).
 * No node:fs, path joining, or process.cwd() may leak through this interface.
 */
export interface JobStorePort {
  /**
   * Retrieve a job by its handle (`id`).
   * Returns undefined if no job with that id exists or if it has expired.
   */
  getJob(id: string): Promise<Job | undefined>;

  /**
   * Retrieve the full stored job entry including campaignId and timestamps.
   */
  getStoredJob(id: string): Promise<StoredJob | undefined>;

  /**
   * Conditionally acquire a running job slot for a campaign.
   * If a job is already running for this campaign, returns { acquired: false, runningJobId }.
   * If no job is running, creates the job and returns { acquired: true, jobId }.
   */
  acquireJob(
    campaignId: string,
    customId?: string,
  ): Promise<{ acquired: true; jobId: string } | { acquired: false; runningJobId: string }>;

  /**
   * Create a new running job for a campaign.
   */
  createJob(campaignId: string, customId?: string): Promise<string>;

  /**
   * The id of the job still running for this campaign, else undefined.
   */
  getRunningJobId(campaignId: string): Promise<string | undefined>;

  /**
   * True while a job for this campaign is still running — one run per campaign at a time.
   */
  hasRunningJob(campaignId: string): Promise<boolean>;

  /**
   * Record how far a running job has got.
   *
   * Progress is advisory: a job that has already settled keeps the counts its
   * settlement wrote. A late tick from work still unwinding after the run
   * deadline aborted it (see `runJob`) must not resurrect a failed job, and
   * a tick racing `completeJob` must not walk `n/n` back to `n-1/n`.
   */
  progressJob(id: string, done: number, total: number): Promise<void>;

  /**
   * Settle a job as completed with its result payload.
   */
  completeJob(id: string, payload: JobResult): Promise<void>;

  /**
   * Settle a job as failed with an error message.
   */
  failJob(id: string, error: string): Promise<void>;

  /**
   * Delete a job by id.
   */
  deleteJob(id: string): Promise<void>;

  /**
   * List all stored jobs, ordered by creation time ascending.
   */
  listJobs(): Promise<readonly StoredJob[]>;

  /**
   * Clear all jobs (test seam).
   */
  clear(): Promise<void>;

  /**
   * Execute a critical section with concurrency locking per campaign or job.
   */
  withJobLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

export type JobRegistryPort = JobStorePort;

/**
 * R6 of the lock plan (D73 – D81, bound by D171): a job row is not only a job's
 * record, it is the run's lease, adoption handle and poll target, so the run
 * registry the lock plan called for is this same port with one more capability —
 * extending the lease a claim holds. `JobStorePort` stays the type every route
 * and `lib/jobs.ts` helper is written against (it needs no lease knowledge);
 * `RunRegistryPort` is what a lease-backed adapter (`PgJobStore`, PT-6a)
 * implements, and `runJob` narrows to it (`"heartbeat" in store`) to keep a
 * claim alive for as long as its work runs. A single-process store (`FsJobStore`)
 * excludes runs with its in-memory lock chain instead and never lapses a lease,
 * so it implements `JobStorePort` only.
 */
export interface RunRegistryPort extends JobStorePort {
  /**
   * Extend the lease a running job holds, so a live worker's campaign survives
   * the reaper. A no-op if the job no longer holds one (already settled or
   * already reaped): heartbeating a lease you no longer hold proves nothing.
   */
  heartbeat(id: string): Promise<void>;
}
