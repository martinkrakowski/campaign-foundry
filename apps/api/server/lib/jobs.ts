import type { PipelineResult } from "@campaignfoundry/CampaignOrchestration";

export type JobStatus = "running" | "completed" | "failed";

/** The `{ halted, assets, log }` payload a completed run used to return on POST. */
export interface JobResult {
  halted: boolean;
  assets: PipelineResult["assets"];
  log: PipelineResult["log"];
}

export interface Job {
  status: JobStatus;
  done: number;
  total: number;
  log: PipelineResult["log"] | null;
  result?: JobResult;
  error?: string;
}

/** In-process only — a restart empties this map and GET /campaigns/jobs/:id 404s. */
const jobs = new Map<string, Job>();

export function createJob(): string {
  const id = crypto.randomUUID();
  jobs.set(id, { status: "running", done: 0, total: 0, log: null });
  return id;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function completeJob(id: string, payload: JobResult): void {
  const n = payload.halted ? 0 : payload.assets.length;
  jobs.set(id, {
    status: "completed",
    done: n,
    total: n,
    log: payload.log,
    result: payload,
  });
}

export function failJob(id: string, error: string): void {
  jobs.set(id, { status: "failed", done: 0, total: 0, log: null, error });
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
