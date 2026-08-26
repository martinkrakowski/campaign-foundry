import { argv } from "node:process";
import { pathToFileURL } from "node:url";
import { loadBrief } from "../server/lib/load-brief.js";
import { runCampaign } from "../server/lib/pipeline.js";
import { outputRoot } from "../server/lib/config.js";
import { writeReport } from "../server/lib/report.js";
import { probeFfmpeg, setCapabilities } from "../server/lib/capabilities.js";

const CLI_PROBE_TIMEOUT_MS = 2_000;

function arg(flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function main(briefPathArg?: string): Promise<void> {
  // The brief parser still rejects `formats: motion`, so there is nothing to gate
  // the probe on yet; cap it instead so a wedged binary cannot stall the CLI.
  const cap = await probeFfmpeg({ timeoutMs: CLI_PROBE_TIMEOUT_MS });
  setCapabilities(cap);
  if (!cap.motion) {
    console.warn(`[generate] motion unavailable: ${cap.reason}`);
  }

  const briefPath = briefPathArg ?? arg("--brief") ?? "briefs/sample-campaign.yaml";
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
    // brandCompliant is derived (density gate AND logo present).
    const mark = asset.passedCompliance && asset.logoApplied ? "ok " : "warn";
    const logo = asset.logoApplied ? "logo ok" : "logo missing";
    console.log(
      `  [${mark}] ${asset.outputPath}   ${asset.treatment.padEnd(12)} brand-density ${asset.complianceScore.toFixed(3)}   ${logo}`,
    );
  }
  const reportPath = await writeReport(result.value);
  console.log(`\n  Done — ${assets.length} creatives + proofs in ${outputRoot()}`);
  console.log(`  Report: ${reportPath}\n`);
}

/* istanbul ignore next -- CLI entry guard; main() is covered directly in tests */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
