import { PlanVariationsUseCase } from "@campaignfoundry/CampaignOrchestration";
import { nodeCryptoPolicyHasher } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { parseBrief } from "../../lib/load-brief.js";
import { planInputFor } from "../../lib/pools.js";
import {
  NOT_PROBED_REASON,
  PROBE_PENDING_ERROR,
  waitForCapabilities,
} from "../../lib/capabilities.js";
import { getBriefStore } from "../../lib/ports/index.js";

import { requestTenant } from "../../lib/tenant.js";
/**
 * POST /campaigns/plan — dry-run the variation planner (no generation).
 *
 * Body is a campaign brief. 200 returns the plan summary the wizard estimates
 * from; planner errors are 422 (including a missing/empty/invalid copy pool when
 * the brief requests `headline: pool://copy`); parse failures are 400 (same as generate).
 * A run arriving before the boot capability probe settles waits for it (bounded by
 * the probe's own timeout); if the probe still has not landed the answer is 503 with
 * a retry hint — never a 400 that reads as an invalid brief.
 *
 * PT-5c2: the brief's campaign must be known — `campaignMeta(brief.id)` defined,
 * on both backends (unlike `campaignVisibility`/`resolveCampaign`, which miss a
 * versionless campaign on fs) — else 404, hidden and missing answering the
 * identical body. This route no longer special-cases a hidden campaign's pool
 * alone: since every editor session opens an already-minted campaign
 * (PT-5c1), the whole route is now gated the same way `generate` and
 * `preview-frame` are.
 */
export default defineEventHandler(async (event) => {
  const capabilities = await waitForCapabilities();
  if (capabilities.reason === NOT_PROBED_REASON) {
    setResponseStatus(event, 503);
    setHeader(event, "retry-after", 1);
    return { error: PROBE_PENDING_ERROR };
  }
  let brief;
  try {
    brief = parseBrief(await readBody(event), { enforceCapabilities: true, capabilities });
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: error instanceof Error ? error.message : "Invalid campaign brief" };
  }

  if (brief.mode !== "variation") {
    setResponseStatus(event, 400);
    return { error: "not a variation brief" };
  }

  const scope = requestTenant(event);
  const briefs = getBriefStore(scope);
  if ((await briefs.campaignMeta(brief.id)) === undefined) {
    setResponseStatus(event, 404);
    return { error: `Campaign "${brief.id}" not found.` };
  }

  const input = await planInputFor(scope, brief);
  if (!input.success) {
    setResponseStatus(event, 422);
    return { error: input.error.message };
  }
  const planned = new PlanVariationsUseCase(nodeCryptoPolicyHasher).plan(brief, input.value);
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
      ...(variant.headline === undefined ? {} : { headline: variant.headline }),
      // Motion slots only — static plans serialize exactly as before.
      ...(variant.motion !== undefined
        ? { motion: variant.motion, durationSec: variant.durationSec }
        : {}),
    })),
  };
});
