import { resolve } from "node:path";
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
      throw new Error(
        `Malformed KEY_ENCRYPTION_KEYS entry: version must follow "v<n>" format, got "${version}".`,
      );
    }

    if (keys.has(version)) {
      throw new Error(`Duplicate key encryption version "${version}" in KEY_ENCRYPTION_KEYS.`);
    }

    if (!/^[A-Za-z0-9+/]+=*$/.test(keyBase64)) {
      throw new Error(
        `Invalid base64 key in KEY_ENCRYPTION_KEYS for version "${version}".`,
      );
    }

    const decoded = Buffer.from(keyBase64, "base64");
    if (decoded.toString("base64") !== keyBase64) {
      throw new Error(
        `Invalid base64 key in KEY_ENCRYPTION_KEYS for version "${version}".`,
      );
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
    throw new Error(
      "KEY_ENCRYPTION_KEY_CURRENT is required when KEY_ENCRYPTION_KEYS is set.",
    );
  }

  if (!keys.has(currentVersion)) {
    throw new Error(
      `KEY_ENCRYPTION_KEY_CURRENT "${currentVersion}" not found in KEY_ENCRYPTION_KEYS.`,
    );
  }

  return {
    currentVersion,
    keys,
  };
}

