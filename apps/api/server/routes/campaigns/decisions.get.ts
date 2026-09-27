import { SAFE_ID_PATTERN } from "@campaignfoundry/CampaignOrchestration";
import { campaignKnown, resolveCampaignRef } from "../../lib/ownership.js";
import { getDecisionStore } from "../../lib/ports/index.js";
import { requestTenant } from "../../lib/tenant.js";

/**
 * GET /campaigns/decisions?campaignId= — a campaign's review decisions (D173),
 * each with its verdict, who gave it, when and against which run, plus the
 * `revision` a save must name. `{ decisions: {}, revision: null }` when none
 * are recorded; 400 for a missing or unsafe id; 404 when unowned (PT-2b).
 */
export default defineEventHandler(async (event) => {
  const campaignId = getQuery(event).campaignId;
  if (typeof campaignId !== "string" || !SAFE_ID_PATTERN.test(campaignId)) {
    setResponseStatus(event, 400);
    return { error: "Invalid campaign id" };
  }
  const scope = requestTenant(event);
  const slug = await resolveCampaignRef(scope, campaignId);
  await campaignKnown(scope, slug, "report");
  return getDecisionStore(scope).readDecisions(slug);
});
