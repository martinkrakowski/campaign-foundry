import { resolve } from "node:path";
import { projectRoot } from "@campaignfoundry/shared";

/**
 * Absolute directory creatives are written to. Override with OUTPUT_DIR; defaults
 * to <repo-root>/output so the CLI and the Nitro server resolve to the same place.
 */
export function outputRoot(): string {
  return resolve(projectRoot(), process.env.OUTPUT_DIR ?? "output");
}
