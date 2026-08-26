import { PlanVariationsUseCase } from "@campaignfoundry/CampaignOrchestration";
import { parseBrief } from "../../lib/load-brief.js";
import { platformZones } from "../../lib/pipeline.js";

/**
 * POST /campaigns/plan — dry-run the variation planner (no generation).
 *
 * Body is a campaign brief. 200 returns the plan summary the wizard estimates
 * from; planner errors are 422; parse failures are 400 (same as generate).
 */
export default defineEventHandler(async (event) => {
  let brief;
  try {
    brief = parseBrief(await readBody(event));
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: error instanceof Error ? error.message : "Invalid campaign brief" };
  }

  if (brief.mode !== "variation") {
    setResponseStatus(event, 400);
    return { error: "not a variation brief" };
  }

  const planned = new PlanVariationsUseCase(platformZones).plan(brief);
  if (!planned.success) {
    setResponseStatus(event, 422);
    return { error: planned.error.message };
  }

  const plan = planned.value;
  return {
    policyHash: plan.policyHash,
    seed: plan.seed,
    estimate: plan.estimate,
    variants: plan.variants.map((variant) => ({
      index: variant.index,
      productId: variant.productId,
      aspectRatio: variant.aspectRatio,
      layout: variant.layout,
      tone: variant.tone,
      backgroundSource: variant.backgroundSource,
      paletteShift: variant.paletteShift,
      // Motion slots only — static plans serialize exactly as before.
      ...(variant.motion !== undefined ? { motion: variant.motion, durationSec: variant.durationSec } : {}),
    })),
  };
});
