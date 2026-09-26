import { runEnvironment } from "../run-environment.js";
import { runJob, startQueuedJob } from "../jobs.js";
import { executeRunRequest, type RunRequest } from "../run-request.js";

/**
 * Port for delivering run requests to execution (PT-6b1, D171, D174d).
 * Abstracts how a run request reaches its worker — in-process delivery today,
 * Kafka queue delivery in PT-6b2.
 */
export interface RunDeliveryPort {
  deliver(request: RunRequest): Promise<void>;
}

/**
 * In-process adapter for RunDeliveryPort.
 * Attempts to claim the queued job by calling `startQueuedJob`.
 * If `startQueuedJob` returns false (duplicate delivery or expired lease/TTL),
 * the request is dropped and logged.
 * Otherwise, `runJob` is invoked with `executeRunRequest`.
 */
export class InProcessRunDelivery implements RunDeliveryPort {
  async deliver(request: RunRequest): Promise<void> {
    const env = runEnvironment(request.tenant);
    const started = await startQueuedJob(env, request.jobId);
    if (!started) {
      console.warn(
        `[run-delivery] Dropping duplicate or expired run request for job "${request.jobId}"`,
      );
      return;
    }
    runJob(env, request.jobId, (signal) => executeRunRequest(request, signal));
  }
}

let activeDelivery: RunDeliveryPort = new InProcessRunDelivery();

/** Get the current run delivery port adapter (the registry selects it). */
export function getRunDelivery(): RunDeliveryPort {
  return activeDelivery;
}

/** Test seam: override the run delivery port adapter. */
export function setRunDelivery(delivery: RunDeliveryPort): void {
  activeDelivery = delivery;
}

/** Test seam: reset the run delivery port adapter to the default in-process adapter. */
export function resetRunDelivery(): void {
  activeDelivery = new InProcessRunDelivery();
}
