import { Kafka, type Consumer, type EachMessagePayload } from "kafkajs";
import { SAFE_ID_PATTERN } from "@campaignfoundry/CampaignOrchestration";
import { kafkaSettings, type KafkaSettings } from "./config.js";
import { startOrDropWithSettled, type RunRequest } from "./run-request.js";

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
  private readonly maxInFlight: number;
  private running = false;
  private inFlight = 0;
  private paused = false;

  constructor(settings?: KafkaSettings, kafkaClient?: Kafka, consumer?: Consumer) {
    const config = settings ?? kafkaSettings();
    if (!config) {
      throw new Error("Cannot initialize RunConsumer without Kafka settings.");
    }
    this.topic = config.topic;
    this.maxInFlight = config.maxInFlight ?? 2;
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
    // Set before the first await so a concurrent `stop()` (e.g. a Nitro
    // close hook firing while `connect()` is still pending) sees a
    // consumer that is already "running" and disconnects it, rather than
    // finding `running` still false and treating stop() as a no-op.
    this.running = true;
    try {
      await this.consumer.connect();
      await this.consumer.subscribe({ topic: this.topic, fromBeginning: true });
      await this.consumer.run({
        autoCommit: false,
        eachMessage: async (payload: EachMessagePayload) => {
          await this.handleMessage(payload, async (topic, partition, offset) => {
            await this.consumer.commitOffsets([{ topic, partition, offset }]);
          });
        },
      });
      if (!this.running) {
        // A `stop()` landed while startup was still in flight: it already
        // flipped the flag and disconnected, but connect()/subscribe()/run()
        // kept going underneath it and re-established a live session after
        // shutdown began. Undo it — kafkajs's disconnect is safe to call
        // again on an already-disconnected consumer.
        await this.consumer.disconnect();
      }
    } catch (error) {
      this.running = false;
      // Best-effort: the startup error is what the caller needs, not a
      // failure from cleaning up after it.
      await this.consumer.disconnect().catch(() => undefined);
      throw error;
    }
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
    const result = await startOrDropWithSettled(request);
    if (result.started) {
      this.inFlight++;
      if (this.inFlight >= this.maxInFlight && !this.paused) {
        this.consumer.pause([{ topic: this.topic }]);
        this.paused = true;
      }
      const onSettled = () => {
        this.inFlight = Math.max(0, this.inFlight - 1);
        if (this.running && this.inFlight < this.maxInFlight && this.paused) {
          this.consumer.resume([{ topic: this.topic }]);
          this.paused = false;
        }
      };
      void result.settled.then(onSettled, onSettled);
    }
    await commitOffset();
  }

  async stop(): Promise<void> {
    if (this.running) {
      await this.consumer.disconnect();
      this.running = false;
      this.paused = false;
    }
  }
}
