import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PipelineResult } from "@campaignfoundry/CampaignOrchestration";
import { outputRoot } from "./config.js";

/** Persist a run's report.json under the output root; returns its path. */
export async function writeReport(result: PipelineResult): Promise<string> {
  const root = outputRoot();
  await mkdir(root, { recursive: true });
  const path = resolve(root, "report.json");
  // `brandCompliant` is a derived view field (density gate AND logo present); the
  // entity keeps the two raw signals as the source of truth.
  const assets = result.assets.map((a) => ({
    ...a,
    brandCompliant: a.passedCompliance && a.logoApplied,
  }));
  await writeFile(
    path,
    JSON.stringify({ halted: result.halted, assets, log: result.log }, null, 2),
  );
  return path;
}
