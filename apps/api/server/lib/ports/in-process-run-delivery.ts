import { runEnvironment } from "../run-environment.js";
import { runJob, startQueuedJob } from "../jobs.js";
import { executeRunRequest, type RunRequest } from "../run-request.js";
import type { RunDeliveryPort } from "./run-delivery.port.js";

/**
 * In-process adapter for RunDeliveryPort (PT-6b1, D171, D174d).
 * Attempts to claim the queued job by calling `startQueuedJob`.
 * If `startQueuedJob` returns false (duplicate delivery or expired lease/TTL),
 * the request is dropped and logged.
 * Otherwise, `runJob` is invoked with `executeRunRequest`.
 *
 * Split out of `run-delivery.port.ts` (finding 6a, PR #599 fix round): the
 * class is the thing that actually needs `run-request.js` (and, through it,
 * `pipeline.ts`, which imports this directory's own barrel for
 * `getUsageStore`) — the port interface does not.
 *
 * Not selected from `lib/ports/index.ts` the way the other adapters are
 * (finding 6b, PR #599 second round): that chain reaches back into
 * `jobs.js`, which imports `getJobStore` from the same barrel, so wiring this
 * class into `ports/index.ts` closed a cycle back on itself. Selected from
 * `run-delivery-registry.ts` instead — see that file's docstring.
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
