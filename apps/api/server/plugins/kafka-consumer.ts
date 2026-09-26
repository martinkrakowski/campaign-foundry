import { kafkaSettings, type KafkaSettings } from "../lib/config.js";
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
) {
  return defineNitroPlugin(async (nitroApp?: NitroApp) => {
    const settings = kafkaSettings();
    if (!settings?.consume) return;

    const consumer = consumerFactory(settings);
    await consumer.start();

    if (nitroApp?.hooks?.hook) {
      nitroApp.hooks.hook("close", async () => {
        await consumer.stop();
      });
    }
  });
}

export default createKafkaConsumerPlugin();
