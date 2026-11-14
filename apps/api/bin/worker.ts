import { pathToFileURL } from "node:url";
import { Kafka, logLevel, type Admin } from "kafkajs";
import {
  kafkaSettings,
  objectStore,
  objectStoreSettings,
  storeBackend,
  type KafkaSettings,
  type ObjectStoreMode,
  type StoreBackend,
} from "../server/lib/config.js";
import { database } from "../server/lib/db/database.js";
import type { SqlClient } from "../server/lib/db/sql-client.js";
import { loadEnv } from "../server/lib/env.js";
import { objectStoreClient } from "../server/lib/object-store/index.js";
import { RunConsumer } from "../server/lib/run-consumer.js";
import type { ObjectStorePort } from "@campaignfoundry/CampaignOrchestration";

export interface WorkerConsumer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Every collaborator the startup preflight touches, injectable for tests. */
export interface PreflightDeps {
  /** The configured store backend (`STORE_BACKEND`). */
  getStoreBackend: () => StoreBackend;
  /** The configured object-store mode (`OBJECT_STORE`). */
  getObjectStoreMode: () => ObjectStoreMode;
  /** The SQL client, so TLS and credentials are exercised without a raw socket. */
  getDb: () => SqlClient;
  /** The object-store client, so reachability, SigV4, and ACLs are exercised. */
  getObjectStore: () => ObjectStorePort;
  /** Builds the Kafka admin whose metadata fetch proves broker reachability. */
  createKafkaAdmin: (settings: KafkaSettings) => Admin;
}

/** A diagnostic token (`code`/`type`) worth naming — never a message or URL. */
const SAFE_TOKEN = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * The safe part of a preflight error: a token like `ECONNREFUSED`,
 * `28P01`, or `NoSuchBucket`, and nothing else — never `err.message`,
 * a connection string, an endpoint, or a certificate.
 */
function diagnosticSuffix(err: unknown): string {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  const type = (err as { type?: unknown } | null | undefined)?.type;
  if (typeof code === "string" && SAFE_TOKEN.test(code)) return ` (code: ${code})`;
  if (typeof type === "string" && SAFE_TOKEN.test(type)) return ` (code: ${type})`;
  return "";
}

/** The one message a preflight failure may carry, for the dependency `name`. */
function preflightError(name: string, err: unknown): Error {
  return new Error(
    `Cannot start worker: ${name} preflight failed${diagnosticSuffix(err)}; ` +
      "commonly caused by a network policy, TLS/ACL mismatch, or invalid credentials.",
  );
}

/** The production Kafka admin: one attempt, short timeouts, silent logging. */
export function defaultKafkaAdmin(settings: KafkaSettings): Admin {
  const client = new Kafka({
    clientId: "campaign-foundry-worker-preflight",
    brokers: [...settings.brokers],
    ssl: settings.ssl
      ? {
          rejectUnauthorized: true,
          ca: settings.ssl.ca ? [settings.ssl.ca] : undefined,
          cert: settings.ssl.cert,
          key: settings.ssl.key,
        }
      : undefined,
    connectionTimeout: 5_000,
    requestTimeout: 5_000,
    retry: { retries: 0 },
    logLevel: logLevel.NOTHING,
  });
  return client.admin({ retry: { retries: 0 } });
}

export const defaultPreflightDeps: PreflightDeps = {
  getStoreBackend: storeBackend,
  getObjectStoreMode: objectStore,
  getDb: database,
  getObjectStore: objectStoreClient,
  createKafkaAdmin: defaultKafkaAdmin,
};

/**
 * Verify live connectivity to every dependency the worker will use, one
 * read-only operation per active dependency and zero retries, before the
 * consumer starts. Fails fast with a secret-safe message naming the
 * unreachable dependency — the Kubernetes fallback that kafkajs' silent
 * retries cannot give (a NetworkPolicy that blocks egress leaves the Pod
 * `1/1 Running` while every run fails inside `handleMessage`).
 */
export async function preflightDependencies(
  settings: KafkaSettings,
  deps: PreflightDeps = defaultPreflightDeps,
): Promise<void> {
  if (deps.getStoreBackend() === "postgres") {
    try {
      await deps.getDb().query("SELECT 1");
    } catch (err: unknown) {
      throw preflightError("Postgres", err);
    }
  }
  if (deps.getObjectStoreMode() === "s3") {
    try {
      // `list` — not `get`/`head`: the S3 adapter rejects `404 NoSuchBucket`
      // on `list`, so a missing bucket fails here instead of per run.
      await deps.getObjectStore().list("_preflight");
    } catch (err: unknown) {
      throw preflightError("S3 object store", err);
    }
  }
  const admin = deps.createKafkaAdmin(settings);
  try {
    await admin.connect();
    await admin.fetchTopicMetadata({ topics: [settings.topic] });
  } catch (err: unknown) {
    throw preflightError("Kafka", err);
  } finally {
    try {
      await admin.disconnect();
    } catch {
      // A failed disconnect must never mask a primary preflight failure.
    }
  }
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
  preflight: (settings: KafkaSettings) => Promise<void> = preflightDependencies,
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

  // Preflight AFTER the PT-4d guard and `resolveSettings()`, BEFORE the
  // consumer takes runs off the queue: a worker that starts without its
  // dependencies fails every one of them. One attempt, no retries.
  logger.log("[worker] Preflight: verifying Postgres, object store, and Kafka...");
  await preflight(settings);
  logger.log("[worker] Preflight passed; all configured dependencies are reachable.");

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
