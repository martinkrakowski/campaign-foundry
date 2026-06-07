import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PipelineResult } from "@campaignfoundry/CampaignOrchestration";
import { outputRoot } from "./config.js";

/** Persist a run's report.json under the output root; returns its path. */
export async function writeReport(result: PipelineResult): Promise<string> {
  const root = outputRoot();
  await mkdir(root, { recursive: true });
  const path = resolve(root, "report.json");
  await writeFile(
    path,
    JSON.stringify({ halted: result.halted, assets: result.assets, log: result.log }, null, 2),
  );
  return path;
}
