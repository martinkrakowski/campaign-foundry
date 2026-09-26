import { Kafka, type Producer } from "kafkajs";
import { kafkaSettings, type KafkaSettings } from "../config.js";
import type { RunRequest } from "../run-request.js";
import type { RunDeliveryPort } from "./run-delivery.port.js";

/**
 * Kafka adapter for RunDeliveryPort (PT-6b2, D171, D174d).
 * Delivers run requests across Kafka by publishing a serialized RunRequest
 * keyed `<orgId>:<campaignId>` to the configured topic, awaiting broker ack.
 *
 * A publish failure throws, so callers (such as `generate.post.ts`) can delete
 * the queued job row on delivery failure.
 */
export class KafkaRunDelivery implements RunDeliveryPort {
  private readonly producer: Producer;
  private readonly topic: string;
  private connected = false;

  constructor(settings?: KafkaSettings, kafkaClient?: Kafka, producer?: Producer) {
    const config = settings ?? kafkaSettings();
    if (!config) {
      throw new Error("Cannot initialize KafkaRunDelivery without Kafka settings.");
    }
    this.topic = config.topic;
    if (producer) {
      this.producer = producer;
    } else {
      const client =
        kafkaClient ??
        new Kafka({
          clientId: "campaign-foundry",
          brokers: [...config.brokers],
          ssl: config.ssl
            ? {
                rejectUnauthorized: true,
                ca: config.ssl.ca ? [config.ssl.ca] : undefined,
                cert: config.ssl.cert,
                key: config.ssl.key,
              }
            : undefined,
        });
      this.producer = client.producer();
    }
  }

  private connectPromise: Promise<void> | null = null;

  private async ensureConnected(): Promise<void> {
    if (this.connected) return;
    if (!this.connectPromise) {
      this.connectPromise = (async () => {
        try {
          await this.producer.connect();
          this.connected = true;
        } finally {
          this.connectPromise = null;
        }
      })();
    }
    await this.connectPromise;
  }

  async deliver(request: RunRequest): Promise<void> {
    await this.ensureConnected();
    const key = `${request.tenant.orgId}:${request.brief.id}`;
    const value = JSON.stringify(request);
    await this.producer.send({
      topic: this.topic,
      acks: -1,
      messages: [{ key, value }],
    });
  }

  async disconnect(): Promise<void> {
    if (this.connectPromise) {
      try {
        await this.connectPromise;
      } catch {
        // connect error during shutdown is swallowed
      }
    }
    if (this.connected) {
      await this.producer.disconnect();
      this.connected = false;
    }
  }
}
