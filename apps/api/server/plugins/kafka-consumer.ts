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

export function createKafkaConsumerPlugin(
  consumerFactory: (settings: KafkaSettings) => ConsumerInstance = (s) => new RunConsumer(s),
  logger: Pick<Console, "error"> = console,
) {
  return defineNitroPlugin((nitroApp) => {
    let settings: KafkaSettings | undefined;
    try {
      settings = kafkaSettings();
    } catch (err: unknown) {
      logger.error(
        `[kafka-plugin] Error reading Kafka settings: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (!settings?.consume) return;

    const consumer = consumerFactory(settings);

    const appWithHooks = nitroApp as
      | { hooks?: { hook?: (name: "close", cb: () => Promise<void> | void) => void } }
      | undefined;
    if (appWithHooks?.hooks?.hook) {
      appWithHooks.hooks.hook("close", async () => {
        await consumer.stop();
        await closeRunDelivery();
      });
    }

    consumer.start().catch((err: unknown) => {
      logger.error(
        `[kafka-plugin] Error starting Kafka consumer: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  });
}

export default createKafkaConsumerPlugin();
