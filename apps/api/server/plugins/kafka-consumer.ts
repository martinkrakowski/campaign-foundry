import { kafkaSettings, type KafkaSettings } from "../lib/config.js";
import { closeRunDelivery } from "../lib/ports/run-delivery-registry.js";
import { RunConsumer } from "../lib/run-consumer.js";

export interface ConsumerInstance {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface NitroHooks {
  hook(name: "close", cb: () => Promise<void> | void): void;
}

export interface NitroApp {
  hooks?: NitroHooks;
}

export interface KafkaPluginTimer {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  random?: () => number;
}

const defaultTimer: KafkaPluginTimer = {
  setTimeout,
  clearTimeout,
  random: Math.random,
};

export function calculateBackoff(attempt: number, random = Math.random): number {
  const base = Math.min(60_000, 1_000 * Math.pow(2, attempt - 1));
  const jitter = random() * 1_000;
  return Math.min(60_000, base + jitter);
}

export function createKafkaConsumerPlugin(
  consumerFactory: (settings: KafkaSettings) => ConsumerInstance = (s) => new RunConsumer(s),
  logger: Pick<Console, "error"> = console,
  resolveSettings: () => KafkaSettings | undefined = kafkaSettings,
  timer: KafkaPluginTimer = defaultTimer,
) {
  return defineNitroPlugin((nitroApp) => {
    let settings: KafkaSettings | undefined;
    try {
      settings = resolveSettings();
    } catch (err: unknown) {
      logger.error(
        `[kafka-plugin] Error reading Kafka settings: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (!settings?.consume) return;

    const consumer = consumerFactory(settings);

    let closed = false;
    let pendingRetryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const cancelPendingRetry = () => {
      if (pendingRetryTimer !== undefined) {
        timer.clearTimeout(pendingRetryTimer);
        pendingRetryTimer = undefined;
      }
    };

    const appWithHooks = nitroApp as
      | { hooks?: { hook?: (name: "close", cb: () => Promise<void> | void) => void } }
      | undefined;
    if (appWithHooks?.hooks?.hook) {
      appWithHooks.hooks.hook("close", async () => {
        closed = true;
        cancelPendingRetry();
        // A failed consumer disconnect must not leave the delivery producer open.
        try {
          await consumer.stop();
        } catch (err: unknown) {
          logger.error(
            `[kafka-plugin] Error stopping Kafka consumer: ${err instanceof Error ? err.message : String(err)}`,
          );
        } finally {
          await closeRunDelivery();
        }
      });
    }

    const tryStart = async () => {
      if (closed) return;
      attempt++;
      try {
        await consumer.start();
      } catch (err: unknown) {
        logger.error(
          `[kafka-plugin] Error starting Kafka consumer (attempt ${attempt}): ${err instanceof Error ? err.message : String(err)}`,
        );
        if (closed) return;
        const delay = calculateBackoff(attempt, timer.random ?? Math.random);
        pendingRetryTimer = timer.setTimeout(() => {
          pendingRetryTimer = undefined;
          void tryStart();
        }, delay);
      }
    };

    void tryStart();
  });
}

export default createKafkaConsumerPlugin();
