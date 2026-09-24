import { resolve } from "node:path";
import { projectRoot } from "@campaignfoundry/shared";
import type { DatabaseSettings } from "./db/database-config.js";

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
  return {
    url: process.env.DATABASE_URL,
    caPath: process.env.DATABASE_CA_PATH,
    poolMax: process.env.DATABASE_POOL_MAX,
  };
}
