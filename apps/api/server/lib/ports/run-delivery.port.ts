import type { RunRequest } from "../run-request.js";

/**
 * Port for delivering run requests to execution (PT-6b1, D171, D174d).
 * Abstracts how a run request reaches its worker — in-process delivery today,
 * Kafka queue delivery in PT-6b2.
 *
 * A pure interface, like the other `*.port.ts` files: `RunRequest` is
 * imported as a type only, so this file pulls in none of `run-request.ts`'s
 * own runtime imports (which reach back into `pipeline.ts` and this
 * directory's own barrel). The in-process adapter that DOES need that chain
 * lives in `in-process-run-delivery.ts`.
 */
export interface RunDeliveryPort {
  deliver(request: RunRequest): Promise<void>;
}
