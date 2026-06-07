import { argv } from "node:process";
import { loadBrief } from "../server/lib/load-brief.js";
import { runCampaign } from "../server/lib/pipeline.js";
import { outputRoot } from "../server/lib/config.js";
import { writeReport } from "../server/lib/report.js";

function arg(flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const briefPath = arg("--brief") ?? "briefs/sample-campaign.yaml";
  console.log(`\n  Campaign Foundry — generating from ${briefPath}\n`);

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
    const mark = asset.passedCompliance && asset.logoApplied ? "ok " : "warn";
    const logo = asset.logoApplied ? "logo ok" : "logo missing";
    console.log(
      `  [${mark}] ${asset.outputPath}   brand-density ${asset.complianceScore.toFixed(3)}   ${logo}`,
    );
  }
  const reportPath = await writeReport(result.value);
  console.log(`\n  Done — ${assets.length} creatives + proofs in ${outputRoot()}`);
  console.log(`  Report: ${reportPath}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
