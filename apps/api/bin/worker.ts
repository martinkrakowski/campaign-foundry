import { pathToFileURL } from "node:url";
import {
  kafkaSettings,
  objectStore,
  objectStoreSettings,
  type KafkaSettings,
} from "../server/lib/config.js";
import { database } from "../server/lib/db/database.js";
import { loadEnv } from "../server/lib/env.js";
import { RunConsumer } from "../server/lib/run-consumer.js";

export interface WorkerConsumer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function main(
  resolveSettings: () => KafkaSettings | undefined = kafkaSettings,
  consumerFactory: (settings: KafkaSettings) => WorkerConsumer = (s) => new RunConsumer(s),
  processRef: Pick<NodeJS.Process, "on" | "removeListener" | "exitCode"> & {
    exit?: (code?: number) => void;
  } = process,
  logger: Pick<Console, "log" | "warn" | "error"> = console,
  endDb: () => Promise<void> | void = async () => {
    try {
      await database().end();
    } catch {
      // Database not configured or already ended
    }
  },
): Promise<{ consumer: WorkerConsumer; shutdown: (signal: string) => Promise<void> }> {
  loadEnv();
  // PT-4d: validate the object store's configuration before anything is
  // consumed, so a missing `S3_*` variable stops the worker here rather than
  // failing every run it renders. No network call — and a WRONG bucket name
  // passes it, because `S3ObjectStore.get` maps every 404 (NoSuchBucket
  // included) to `undefined`. Same guard as `plugins/object-store-boot-guard.ts`.
  if (objectStore() === "s3") objectStoreSettings();
  const settings = resolveSettings();
  if (!settings) {
    throw new Error("Cannot start worker: KAFKA_BROKERS is not set.");
  }

  const consumer = consumerFactory(settings);
  logger.log(
    `[worker] Starting Kafka run consumer on topic "${settings.topic}", group "${settings.groupId}"...`,
  );
  await consumer.start();
  logger.log("[worker] Kafka run consumer is running.");

  let stopped = false;
  const shutdown = async (signal: string) => {
    if (stopped) return;
    stopped = true;
    logger.log(`[worker] Received ${signal}, shutting down Kafka consumer...`);
    try {
      await consumer.stop();
      logger.log("[worker] Kafka consumer stopped cleanly.");
    } catch (err: unknown) {
      logger.error(
        `[worker] Error stopping consumer: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      await endDb();
      logger.log("[worker] Database pool ended.");
    } catch (err: unknown) {
      logger.error(
        `[worker] Error ending database pool: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (processRef.exit) {
      processRef.exit(0);
    }
  };

  const sigintHandler = () => shutdown("SIGINT");
  const sigtermHandler = () => shutdown("SIGTERM");

  processRef.on("SIGINT", sigintHandler);
  processRef.on("SIGTERM", sigtermHandler);

  return { consumer, shutdown };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(`  x  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
