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
