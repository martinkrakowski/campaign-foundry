import { InProcessRunDelivery } from "./in-process-run-delivery.js";
import { KafkaRunDelivery } from "./kafka-run-delivery.js";
import { kafkaSettings } from "../config.js";
import type { RunDeliveryPort } from "./run-delivery.port.js";
import type { StorageScope } from "../run-environment.js";

/**
 * The run-delivery registry (PT-6b1, D171, D174d, PT-6b2) — deliberately kept out of
 * `ports/index.ts`.
 *
 * `InProcessRunDelivery` reaches through `run-request.js` into `jobs.js` and
 * `pipeline.js`, both of which import `getJobStore`/`getUsageStore` from the
 * ports barrel (`ports/index.js`). Wiring it into that same barrel closed the
 * loop back on itself — `ports/index -> in-process-run-delivery -> run-request
 * -> jobs -> ports/index` — the circular dependency `.agents/architecture.md`
 * forbids (review on #599, finding 6: splitting the class out of
 * `run-delivery.port.ts` moved the cycle one file over instead of removing
 * it). This module imports the adapter directly and is never imported back
 * by `ports/index.ts`, so nothing closes the loop.
 *
 * One adapter for the whole process (no per-scope keying, unlike the other
 * registries in `ports/index.ts`): in-process delivery runs in the same
 * process as the route that admits the job, so there is nothing to key per
 * tenant — Kafka delivery (PT-6b2) is the same, scoped by topic rather
 * than by root. When `kafkaSettings()` is defined, `KafkaRunDelivery` is
 * selected; otherwise `InProcessRunDelivery` is selected. A bare module-level
 * pair is enough; `set`/`reset` match the same test seam every other store has.
 */
let override: RunDeliveryPort | undefined;
let instance: RunDeliveryPort | undefined;

export const getRunDelivery = (_scope: StorageScope): RunDeliveryPort => {
  if (override) return override;
  if (!instance) {
    const kafka = kafkaSettings();
    instance = kafka ? new KafkaRunDelivery(kafka) : new InProcessRunDelivery();
  }
  return instance;
};

export const setRunDelivery = (delivery: RunDeliveryPort): void => {
  override = delivery;
};

export const closeRunDelivery = async (): Promise<void> => {
  if (
    instance &&
    "disconnect" in instance &&
    typeof (instance as KafkaRunDelivery).disconnect === "function"
  ) {
    await (instance as KafkaRunDelivery).disconnect();
  }
};

export const resetRunDelivery = (): void => {
  if (
    instance &&
    "disconnect" in instance &&
    typeof (instance as KafkaRunDelivery).disconnect === "function"
  ) {
    void (instance as KafkaRunDelivery).disconnect().catch(() => {});
  }
  override = undefined;
  instance = undefined;
};
