import { argv, exitCode } from "node:process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PipelineResult } from "@campaignforge/CampaignOrchestration";
import { loadBrief } from "../server/lib/load-brief.js";
import { runCampaign } from "../server/lib/pipeline.js";
import { outputRoot } from "../server/lib/config.js";

function arg(flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function writeReport(result: PipelineResult): Promise<string> {
  const root = outputRoot();
  await mkdir(root, { recursive: true });
  const path = resolve(root, "report.json");
  await writeFile(
    path,
    JSON.stringify({ halted: result.halted, assets: result.assets, log: result.log }, null, 2),
  );
  return path;
}

async function main(): Promise<void> {
  const briefPath = arg("--brief") ?? "briefs/sample-campaign.yaml";
  console.log(`\n  Campaign Forge — generating from ${briefPath}\n`);

  const brief = await loadBrief(briefPath);
  const result = await runCampaign(brief);

  if (!result.success) {
    console.error(`  x  ${result.error.message}\n`);
    process.exitCode = 1;
    return;
  }

  const { assets, halted } = result.value;
  if (halted) {
    console.warn("  !  Pipeline halted at the legal gate — no creatives generated.\n");
  }
  for (const asset of assets) {
    const mark = asset.passedCompliance ? "ok " : "warn";
    console.log(`  [${mark}] ${asset.outputPath}   brand-density ${asset.complianceScore.toFixed(3)}`);
  }
  const reportPath = await writeReport(result.value);
  console.log(`\n  Done — ${assets.length} creatives + proofs in ${outputRoot()}`);
  console.log(`  Report: ${reportPath}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
void exitCode;
