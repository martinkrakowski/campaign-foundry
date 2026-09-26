import { Kafka, type Consumer, type EachMessagePayload } from "kafkajs";
import { kafkaSettings, type KafkaSettings } from "./config.js";
import { runJob, startQueuedJob } from "./jobs.js";
import { executeRunRequest, type RunRequest } from "./run-request.js";
import { runEnvironment } from "./run-environment.js";

/** Validates whether an unknown parsed payload matches the RunRequest interface. */
export function isRunRequest(value: unknown): value is RunRequest {
  if (typeof value !== "object" || value === null) return false;
  const req = value as Partial<RunRequest>;
  if (typeof req.jobId !== "string" || req.jobId.trim() === "") return false;
  if (
    typeof req.tenant !== "object" ||
    req.tenant === null ||
    typeof req.tenant.orgId !== "string" ||
    req.tenant.orgId.trim() === ""
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

  constructor(
    settings?: KafkaSettings,
    kafkaClient?: Kafka,
    consumer?: Consumer,
  ) {
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
    await this.consumer.subscribe({ topic: this.topic, fromBeginning: false });
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
    } catch (error: unknown) {
      console.warn(
        `[run-consumer] Dropping malformed JSON message at offset ${message.offset}: ${error instanceof Error ? error.message : String(error)}`,
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
    const env = runEnvironment(request.tenant);
    const started = await startQueuedJob(env, request.jobId);
    if (!started) {
      console.warn(
        `[run-consumer] Dropping duplicate or expired run request for job "${request.jobId}"`,
      );
    } else {
      runJob(env, request.jobId, (signal) => executeRunRequest(request, signal));
    }
    await commitOffset();
  }

  async stop(): Promise<void> {
    if (this.running) {
      await this.consumer.disconnect();
      this.running = false;
    }
  }
}
