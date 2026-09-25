import { JOB_TTL_MS } from "./ports/fs-job-store.js";
import { getJobStore } from "./ports/index.js";
import { HEARTBEAT_INTERVAL_MS, JobLeaseLostError } from "./ports/pg-job-store.js";
import type { StorageScope } from "./run-environment.js";
import { LOCAL_TENANT } from "./tenant.js";
import type {
  Job,
  JobResult,
  JobStatus,
  JobStorePort,
  RunRegistryPort,
  StoredJob,
} from "./ports/job-store.port.js";

export type { JobStatus, JobResult, Job, StoredJob };
export { MAX_JOBS, JOB_TTL_MS } from "./ports/fs-job-store.js";
export { HEARTBEAT_INTERVAL_MS, LEASE_MS } from "./ports/pg-job-store.js";

/**
 * A lease-backed store (`PgJobStore`, PT-6a) also implements `heartbeat`; a
 * single-process store (`FsJobStore`) excludes runs with its own in-memory lock
 * chain and never lapses a lease, so it has nothing to extend. A type guard
 * rather than `"heartbeat" in store`, so the check reads the same regardless of
 * which structural-narrowing behaviour a given TypeScript version gives `in`.
 */
function isRunRegistry(store: JobStorePort): store is RunRegistryPort {
  return typeof (store as Partial<RunRegistryPort>).heartbeat === "function";
}

export async function acquireJob(
  scope: StorageScope,
  campaignId: string,
): Promise<{ acquired: true; jobId: string } | { acquired: false; runningJobId: string }> {
  return getJobStore(scope).acquireJob(campaignId);
}

export async function createJob(scope: StorageScope, campaignId: string): Promise<string> {
  return getJobStore(scope).createJob(campaignId);
}

export async function deleteJob(scope: StorageScope, id: string): Promise<void> {
  return getJobStore(scope).deleteJob(id);
}

export async function getJob(scope: StorageScope, id: string): Promise<Job | undefined> {
  return getJobStore(scope).getJob(id);
}

/**
 * The id of the job still running for this campaign, else undefined — the handle a
 * 409 "already in progress" hands back, so the second press can adopt the run that
 * is actually in flight instead of discarding it.
 */
export async function getRunningJobId(
  scope: StorageScope,
  campaignId: string,
): Promise<string | undefined> {
  return getJobStore(scope).getRunningJobId(campaignId);
}

/** True while a job for this campaign is still running — one run per campaign at a time. */
export async function hasRunningJob(scope: StorageScope, campaignId: string): Promise<boolean> {
  return getJobStore(scope).hasRunningJob(campaignId);
}

/**
 * Record how far a running job has got. Advisory — a settled job keeps the
 * counts its settlement wrote (see `JobStorePort.progressJob`).
 */
export async function progressJob(
  scope: StorageScope,
  id: string,
  done: number,
  total: number,
): Promise<void> {
  return getJobStore(scope).progressJob(id, done, total);
}

export async function completeJob(
  scope: StorageScope,
  id: string,
  payload: JobResult,
): Promise<void> {
  return getJobStore(scope).completeJob(id, payload);
}

export async function failJob(scope: StorageScope, id: string, error: string): Promise<void> {
  return getJobStore(scope).failJob(id, error);
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
  scope: StorageScope,
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
  // The heartbeat (D171 item 3): only a lease-backed store has one to extend.
  // `runJob` is the only place that knows a run's lifetime, so it is the one
  // place that can keep a lease alive for exactly as long as work runs — a
  // tick from the pipeline's own progress callback would be silent for
  // whatever stretch of work reports no progress, which is not a lease.
  const store = getJobStore(scope);
  let heartbeatTimer: NodeJS.Timeout | undefined;
  if (isRunRegistry(store)) {
    heartbeatTimer = setInterval(() => {
      // Swallowed, not surfaced to `work`: a missed heartbeat should not fail a
      // run that is otherwise progressing fine — the lease itself is what
      // decides that (the next fenced write refuses once it lapses). Logged
      // (no structured logger reaches this module) so a run that silently loses
      // its lease this way leaves a trail, per `pg-client.ts`'s own pattern for
      // a background failure nothing awaits.
      void store.heartbeat(id).catch((error: unknown) => {
        console.warn(
          `[jobs] heartbeat failed for job ${id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref();
  }
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
        await failJob(scope, id, reason instanceof Error ? reason.message : "Job failed");
      } catch (failError) {
        // A fenced store throws the same `JobLeaseLostError` here when the
        // reaper already failed this row (or another worker's claim replaced
        // it): that is a real, correctly-settled "failed" record, and
        // deleting it would turn it into a 404. This fallback exists for a
        // genuine storage error — a row stuck "running" with nothing able to
        // settle it — so only delete when the failure was not a lost lease.
        if (!(failError instanceof JobLeaseLostError)) {
          await deleteJob(scope, id).catch(() => undefined);
        }
      }
    } finally {
      clearTimeout(timer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    }
  })();
}

/** Test seam: forget every job the local operator's store holds. */
export async function resetJobs(): Promise<void> {
  return getJobStore(LOCAL_TENANT).clear();
}
