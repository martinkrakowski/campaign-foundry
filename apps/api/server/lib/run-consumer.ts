import { Kafka, type Consumer, type EachMessagePayload } from "kafkajs";
import { SAFE_ID_PATTERN } from "@campaignfoundry/CampaignOrchestration";
import { kafkaSettings, type KafkaSettings } from "./config.js";
import { startOrDrop, type RunRequest } from "./run-request.js";

/** Validates whether an unknown parsed payload matches the RunRequest interface. */
export function isRunRequest(value: unknown): value is RunRequest {
  if (typeof value !== "object" || value === null) return false;
  const req = value as Partial<RunRequest>;
  if (typeof req.jobId !== "string" || req.jobId.trim() === "") return false;
  if (
    typeof req.tenant !== "object" ||
    req.tenant === null ||
    typeof req.tenant.orgId !== "string" ||
    !SAFE_ID_PATTERN.test(req.tenant.orgId) ||
    typeof req.tenant.userId !== "string" ||
    !SAFE_ID_PATTERN.test(req.tenant.userId) ||
    !Array.isArray(req.tenant.roles) ||
    !req.tenant.roles.every((r) => typeof r === "string") ||
    !Array.isArray(req.tenant.teamIds) ||
    !req.tenant.teamIds.every((t) => typeof t === "string")
  ) {
    return false;
  }
  if (
    typeof req.brief !== "object" ||
    req.brief === null ||
    typeof req.brief.id !== "string" ||
    req.brief.id.trim() === ""
  ) {
    return false;
  }
  return true;
}

/**
 * Consumer that processes run requests delivered via Kafka (PT-6b2, D171, D174d).
 *
 * Per message:
 * 1. Parses a RunRequest from the message payload.
 * 2. Calls `startQueuedJob`.
 * 3. Only if `startQueuedJob` returns true, executes the run via `runJob`.
 * 4. Commits the offset AFTER that decision, so duplicate deliveries or replays
 *    lose the claim and are dropped without reprocessing, and malformed messages
 *    are logged and committed rather than retried indefinitely.
 */
export class RunConsumer {
  private readonly consumer: Consumer;
  private readonly topic: string;
  private running = false;

  constructor(settings?: KafkaSettings, kafkaClient?: Kafka, consumer?: Consumer) {
    const config = settings ?? kafkaSettings();
    if (!config) {
      throw new Error("Cannot initialize RunConsumer without Kafka settings.");
    }
    this.topic = config.topic;
    if (consumer) {
      this.consumer = consumer;
    } else {
      const client =
        kafkaClient ??
        new Kafka({
          clientId: "campaign-foundry-consumer",
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
      this.consumer = client.consumer({ groupId: config.groupId });
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: this.topic, fromBeginning: true });
    this.running = true;
    await this.consumer.run({
      autoCommit: false,
      eachMessage: async (payload: EachMessagePayload) => {
        await this.handleMessage(payload, async (topic, partition, offset) => {
          await this.consumer.commitOffsets([{ topic, partition, offset }]);
        });
      },
    });
  }

  async handleMessage(
    payload: EachMessagePayload,
    commit: (topic: string, partition: number, offset: string) => Promise<void>,
  ): Promise<void> {
    const { topic, partition, message } = payload;
    const nextOffset = (BigInt(message.offset) + 1n).toString();
    const commitOffset = () => commit(topic, partition, nextOffset);

    const raw = message.value?.toString("utf8");
    if (!raw) {
      console.warn(`[run-consumer] Dropping empty Kafka message at offset ${message.offset}`);
      await commitOffset();
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      console.warn(
        `[run-consumer] Dropping malformed JSON message at offset ${message.offset}: ${(error as Error).message}`,
      );
      await commitOffset();
      return;
    }

    if (!isRunRequest(parsed)) {
      console.warn(
        `[run-consumer] Dropping malformed RunRequest message at offset ${message.offset}`,
      );
      await commitOffset();
      return;
    }

    const request = parsed;
    await startOrDrop(request);
    await commitOffset();
  }

  async stop(): Promise<void> {
    if (this.running) {
      await this.consumer.disconnect();
      this.running = false;
    }
  }
}
