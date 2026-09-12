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
