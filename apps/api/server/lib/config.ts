import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { projectRoot } from "@campaignfoundry/shared";
import type { DatabaseSettings } from "./db/database-config.js";
import { loadEnv } from "./env.js";

/**
 * Absolute directory creatives are written to. Override with OUTPUT_DIR; defaults
 * to <repo-root>/output so the CLI and the Nitro server resolve to the same place.
 */
export function outputRoot(): string {
  return resolve(projectRoot(), process.env.OUTPUT_DIR ?? "output");
}

/**
 * The database settings, raw (D174a, D167: env is read here, at the composition
 * root, and nowhere below it). `db/database-config.ts` validates them.
 */
export function databaseSettings(): DatabaseSettings {
  loadEnv();
  return {
    url: process.env.DATABASE_URL,
    caPath: process.env.DATABASE_CA_PATH,
    poolMax: process.env.DATABASE_POOL_MAX,
  };
}

/** Where the stores that have a database adapter keep their records (PT-3). */
export type StoreBackend = "fs" | "postgres";

/**
 * `STORE_BACKEND`: `fs` (the default) or `postgres`. Explicit, never inferred from
 * `DATABASE_URL`: an operator's `.env.local` may name a database the app has not
 * been moved onto yet, and switching on its presence would show an empty one.
 */
export function storeBackend(): StoreBackend {
  // First, so a setting in .env.local is seen by the very first request: the
  // registry asks this before anything else has loaded the env files.
  loadEnv();
  const value = process.env.STORE_BACKEND;
  if (value === undefined || value === "" || value === "fs") return "fs";
  if (value === "postgres") return "postgres";
  throw new Error(`STORE_BACKEND must be "fs" or "postgres", not "${value}".`);
}

/** Where rendered bytes and proofs live (PT-4a, D203, D204). */
export type ObjectStoreMode = "fs" | "s3";

/**
 * `OBJECT_STORE`: `fs` (the default — `GET /output/**` serves the bytes, D204)
 * or `s3` (a private bucket plus presigned URLs). Explicit like `STORE_BACKEND`,
 * for the same reason: the presence of an `S3_ENDPOINT` in an operator's
 * `.env.local` is not a decision to move the app onto a bucket.
 */
export function objectStore(): ObjectStoreMode {
  loadEnv();
  const value = process.env.OBJECT_STORE;
  if (value === undefined || value === "" || value === "fs") return "fs";
  if (value === "s3") return "s3";
  throw new Error(`OBJECT_STORE must be "fs" or "s3", not "${value}".`);
}

/** The S3-compatible store's coordinates, read only when `OBJECT_STORE=s3` (D201). */
export interface S3Settings {
  /** `S3_ENDPOINT`: the store the API signs its own requests to (e.g. `http://seaweedfs-s3:8333`). */
  readonly endpoint: string;
  /** `S3_PUBLIC_ENDPOINT`: the browser-reachable origin presigned URLs are signed for. */
  readonly publicEndpoint: string;
  /** `S3_REGION`: the SigV4 region. */
  readonly region: string;
  /** `S3_BUCKET`: the one private bucket. */
  readonly bucket: string;
  /** `S3_ACCESS_KEY_ID`: an app key scoped to that bucket, never the store's admin identity. */
  readonly accessKeyId: string;
  /** `S3_SECRET_ACCESS_KEY`: the app key's secret. Never logged, never echoed in an error. */
  readonly secretAccessKey: string;
}

/** The six variables `s3` needs, in the order a missing one is reported in. */
const S3_VARIABLES = [
  "S3_ENDPOINT",
  "S3_PUBLIC_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
] as const;

/** Whether `value` is an absolute `http(s)` URL — the shape both endpoints must have. */
function isAbsoluteHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

/**
 * The object store's settings, or `undefined` under `fs` (D201, D203).
 *
 * Under `s3` every one of the six variables is required, both endpoints must be
 * absolute `http(s)` URLs — a relative or `s3://` endpoint would produce a URL
 * the signature does not cover — and `STORE_BACKEND` must be `postgres`, because
 * only Postgres knows a campaign uuid and a render key is built from one
 * (D203's exclusive-create tenant scoping).
 *
 * Every message here names the VARIABLE and never its value. An endpoint carries
 * a hostname that may be internal, and a key pair is a credential: a message
 * that quoted one would put it in whatever logged the throw, which is exactly
 * the log a misconfiguration is read from.
 */
export function objectStoreSettings(): S3Settings | undefined {
  if (objectStore() === "fs") return undefined;
  if (storeBackend() !== "postgres") {
    throw new Error(
      "OBJECT_STORE=s3 requires STORE_BACKEND=postgres: only Postgres knows a campaign uuid, and a render key is derived from one.",
    );
  }
  // Collected first, so the endpoint check below reads the value that was
  // already found present rather than a second `process.env` lookup that could
  // in principle see something else.
  const read: Record<string, string> = {};
  for (const name of S3_VARIABLES) {
    const value = process.env[name];
    if (value === undefined || value.trim() === "") {
      throw new Error(`${name} is required when OBJECT_STORE=s3.`);
    }
    read[name] = value;
  }
  for (const name of ["S3_ENDPOINT", "S3_PUBLIC_ENDPOINT"] as const) {
    if (!isAbsoluteHttpUrl(read[name])) {
      throw new Error(`${name} must be an absolute http(s) URL when OBJECT_STORE=s3.`);
    }
  }
  return {
    endpoint: read.S3_ENDPOINT,
    publicEndpoint: read.S3_PUBLIC_ENDPOINT,
    region: read.S3_REGION,
    bucket: read.S3_BUCKET,
    accessKeyId: read.S3_ACCESS_KEY_ID,
    secretAccessKey: read.S3_SECRET_ACCESS_KEY,
  };
}

/** Who a request is authenticated by (PT-1a, D174b). */
export type AuthMode = "local" | "better-auth";

/**
 * `AUTH_MODE`: `local` (the default: every request is `LOCAL_TENANT`, as
 * before PT-1) or `better-auth`. Explicit, like `STORE_BACKEND`, and read
 * beside it — never inferred from `BETTER_AUTH_SECRET`'s presence, for the
 * same reason: an operator's `.env.local` may carry a secret before the
 * database is migrated for it.
 */
export function authMode(): AuthMode {
  loadEnv();
  const value = process.env.AUTH_MODE;
  if (value === undefined || value === "" || value === "local") return "local";
  if (value === "better-auth") return "better-auth";
  throw new Error(`AUTH_MODE must be "local" or "better-auth", not "${value}".`);
}

/** Every other `better-auth` setting (PT-1a item 1), raw: `lib/auth/` validates them. */
export interface AuthSettings {
  /** `BETTER_AUTH_SECRET`: signs sessions and tokens. */
  readonly secret?: string;
  /** `BETTER_AUTH_URL`: the API's own reachable origin (`lib/auth/options.ts`). */
  readonly baseURL?: string;
  /** `WEB_ORIGIN`: the web app's origin, trusted for requests its `/api/pipeline/*` proxy forwards. */
  readonly webOrigin?: string;
  /** `RESEND_API_KEY`: absent means mail only logs (`LogMailer`). */
  readonly resendApiKey?: string;
  /** `EMAIL_FROM`: the address Resend sends as. */
  readonly emailFrom?: string;
  /** `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`: both required to enable Google sign-in (item 9). */
  readonly googleClientId?: string;
  readonly googleClientSecret?: string;
}

export function authSettings(): AuthSettings {
  loadEnv();
  return {
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.BETTER_AUTH_URL,
    webOrigin: process.env.WEB_ORIGIN,
    resendApiKey: process.env.RESEND_API_KEY,
    emailFrom: process.env.EMAIL_FROM,
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  };
}

/** Key encryption settings for org provider keys (PT-7b1, D175, D176). */
export interface KeyEncryptionSettings {
  readonly currentVersion: string;
  readonly keys: ReadonlyMap<string, Buffer>;
}

/**
 * Key encryption settings for envelope encryption of org provider keys (PT-7b1, D175, D176).
 *
 * `KEY_ENCRYPTION_KEYS`: comma-separated list of `v<n>:<base64 32 bytes>`.
 * `KEY_ENCRYPTION_KEY_CURRENT`: names the version that seals new keys.
 *
 * Unset means "no BYOK" (returns undefined). Refuses with clear errors (never
 * echoing key material) on malformed entries, non-32-byte keys, duplicate
 * versions, or a current version not present in the list.
 */
export function keyEncryptionSettings(): KeyEncryptionSettings | undefined {
  loadEnv();
  const rawKeys = process.env.KEY_ENCRYPTION_KEYS;
  if (rawKeys === undefined || rawKeys.trim() === "") {
    return undefined;
  }

  const keys = new Map<string, Buffer>();
  const entries = rawKeys.split(",").map((entry) => entry.trim());

  for (const entry of entries) {
    if (entry === "") {
      throw new Error("Malformed KEY_ENCRYPTION_KEYS: empty entry found.");
    }

    const colonIndex = entry.indexOf(":");
    if (colonIndex === -1) {
      throw new Error("Malformed KEY_ENCRYPTION_KEYS entry: missing colon separator.");
    }

    const version = entry.slice(0, colonIndex).trim();
    const keyBase64 = entry.slice(colonIndex + 1).trim();

    if (!/^v\d+$/.test(version)) {
      // Never echo it: a misplaced key in the version position must not reach a log.
      throw new Error(
        'Malformed KEY_ENCRYPTION_KEYS entry: a version must follow the "v<n>" format.',
      );
    }

    if (keys.has(version)) {
      throw new Error(`Duplicate key encryption version "${version}" in KEY_ENCRYPTION_KEYS.`);
    }

    if (!/^[A-Za-z0-9+/]+=*$/.test(keyBase64)) {
      throw new Error(`Invalid base64 key in KEY_ENCRYPTION_KEYS for version "${version}".`);
    }

    const decoded = Buffer.from(keyBase64, "base64");
    if (decoded.toString("base64") !== keyBase64) {
      throw new Error(`Invalid base64 key in KEY_ENCRYPTION_KEYS for version "${version}".`);
    }

    if (decoded.length !== 32) {
      throw new Error(
        `KEY_ENCRYPTION_KEYS key for version "${version}" must decode to exactly 32 bytes (got ${decoded.length}).`,
      );
    }

    keys.set(version, decoded);
  }

  const currentVersion = process.env.KEY_ENCRYPTION_KEY_CURRENT?.trim();
  if (!currentVersion) {
    throw new Error("KEY_ENCRYPTION_KEY_CURRENT is required when KEY_ENCRYPTION_KEYS is set.");
  }

  if (!keys.has(currentVersion)) {
    // Echo it only when it has a version's shape: anything else may be a misplaced key.
    throw new Error(
      /^v\d+$/.test(currentVersion)
        ? `KEY_ENCRYPTION_KEY_CURRENT "${currentVersion}" not found in KEY_ENCRYPTION_KEYS.`
        : 'KEY_ENCRYPTION_KEY_CURRENT is not a version ("v<n>") in KEY_ENCRYPTION_KEYS.',
    );
  }

  return {
    currentVersion,
    keys,
  };
}

/** TLS configuration for Kafka connection. */
export interface KafkaSslConfig {
  readonly ca?: string;
  readonly cert?: string;
  readonly key?: string;
}

/** Settings for Kafka run delivery and consumption (PT-6b2, D174d). */
export interface KafkaSettings {
  readonly brokers: readonly string[];
  readonly topic: string;
  readonly groupId: string;
  readonly consume: boolean;
  readonly maxInFlight?: number;
  readonly ssl?: KafkaSslConfig;
  readonly clientCertPath?: string;
  readonly clientKeyPath?: string;
  readonly caPath?: string;
}

function looksLikePath(value: string): boolean {
  if (value.length > 256 || value.includes("=") || value.startsWith("MII")) {
    return false;
  }
  return (
    value.includes("/") || value.includes("\\") || /\.[a-z0-9]+$/i.test(value) || value === "certs"
  );
}

function readCertFile(envVar: string, rawPath: string): string {
  if (rawPath.includes("-----BEGIN") || rawPath.includes("\n") || rawPath.includes("\r")) {
    throw new Error(`${envVar} must be a file path under certs/, never inline cert content.`);
  }
  const certsDir = resolve(projectRoot(), "certs");
  const resolved = resolve(projectRoot(), rawPath);
  const rel = relative(certsDir, resolved);
  if (rel.startsWith("..") || isAbsolute(rel) || rel === "") {
    if (looksLikePath(rawPath)) {
      throw new Error(`${envVar} must be a file path under certs/, got "${rawPath}".`);
    }
    throw new Error(`${envVar} must be a file path under certs/.`);
  }
  // `relative` above only rejects lexical traversal in the given path
  // (`../`); a file that is itself lexically under certs/ but is a symlink
  // to somewhere else would pass that check and still be followed by
  // `readFileSync`. Resolve the real target and re-check containment
  // against it, so the confinement covers the file actually read.
  let realPath: string;
  let content: string;
  try {
    realPath = realpathSync(resolved);
    content = readFileSync(realPath, "utf8");
  } catch (error) {
    throw new Error(`Failed to read ${envVar} at "${rawPath}": ${(error as Error).message}`);
  }
  // certs/ itself may be a symlink on an operator machine, so resolve it
  // too rather than comparing a real path against a lexical one.
  const realCertsDir = realpathSync(certsDir);
  const realRel = relative(realCertsDir, realPath);
  if (realRel.startsWith("..") || isAbsolute(realRel) || realRel === "") {
    throw new Error(`${envVar} must be a file path under certs/, got "${rawPath}".`);
  }
  return content;
}

/**
 * Kafka settings for delivering and consuming run requests (PT-6b2, D174d).
 *
 * Reads `KAFKA_BROKERS`, `KAFKA_CLIENT_CERT_PATH`, `KAFKA_CLIENT_KEY_PATH`,
 * `KAFKA_CA_PATH`, `KAFKA_TOPIC` (default `cf.run-requests`), `KAFKA_GROUP_ID`
 * (default `cf-workers`), and `KAFKA_CONSUME` (`true` turns on the in-API consumer).
 *
 * Unset brokers mean Kafka is off and `undefined` is returned.
 * Every cert is read from a file path under `certs/`, never inline.
 */
export function kafkaSettings(): KafkaSettings | undefined {
  loadEnv();
  const rawBrokers = process.env.KAFKA_BROKERS;
  if (rawBrokers === undefined || rawBrokers.trim() === "") {
    return undefined;
  }

  const brokerEntries = rawBrokers.split(",").map((b) => b.trim());
  for (const entry of brokerEntries) {
    if (entry === "") {
      throw new Error("Malformed KAFKA_BROKERS: empty broker entry found.");
    }
  }

  const topic = process.env.KAFKA_TOPIC?.trim() || "cf.run-requests";
  const groupId = process.env.KAFKA_GROUP_ID?.trim() || "cf-workers";
  const consume = process.env.KAFKA_CONSUME === "true";

  const rawMaxInFlight = process.env.KAFKA_MAX_IN_FLIGHT;
  let maxInFlight = 2;
  if (rawMaxInFlight !== undefined && rawMaxInFlight.trim() !== "") {
    const trimmed = rawMaxInFlight.trim();
    const parsed = Number(trimmed);
    if (!/^[1-9]\d*$/.test(trimmed) || !Number.isSafeInteger(parsed)) {
      throw new Error(
        `Malformed KAFKA_MAX_IN_FLIGHT: must be a positive integer, got "${rawMaxInFlight}".`,
      );
    }
    maxInFlight = parsed;
  }

  const caPath = process.env.KAFKA_CA_PATH?.trim();
  const certPath = process.env.KAFKA_CLIENT_CERT_PATH?.trim();
  const keyPath = process.env.KAFKA_CLIENT_KEY_PATH?.trim();

  if ((certPath && !keyPath) || (!certPath && keyPath)) {
    throw new Error(
      "KAFKA_CLIENT_CERT_PATH and KAFKA_CLIENT_KEY_PATH must both be provided for client certificate authentication.",
    );
  }

  const ca = caPath ? readCertFile("KAFKA_CA_PATH", caPath) : undefined;
  const cert = certPath ? readCertFile("KAFKA_CLIENT_CERT_PATH", certPath) : undefined;
  const key = keyPath ? readCertFile("KAFKA_CLIENT_KEY_PATH", keyPath) : undefined;

  const ssl: KafkaSslConfig | undefined =
    ca || cert || key
      ? {
          ...(ca ? { ca } : {}),
          ...(cert ? { cert } : {}),
          ...(key ? { key } : {}),
        }
      : undefined;

  return {
    brokers: brokerEntries,
    topic,
    groupId,
    consume,
    maxInFlight,
    ...(ssl ? { ssl } : {}),
    ...(certPath ? { clientCertPath: certPath } : {}),
    ...(keyPath ? { clientKeyPath: keyPath } : {}),
    ...(caPath ? { caPath } : {}),
  };
}
