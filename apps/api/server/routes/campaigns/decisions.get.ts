import { SAFE_ID_PATTERN } from "@campaignfoundry/CampaignOrchestration";
import { getDecisionStore } from "../../lib/ports/index.js";
import { LOCAL_TENANT } from "../../lib/tenant.js";

/**
 * GET /campaigns/decisions?campaignId= — a campaign's review decisions (D173),
 * each with its verdict, who gave it, when and against which run, plus the
 * `revision` a save must name. `{ decisions: {}, revision: null }` when none
 * are recorded; 400 for a missing or unsafe id.
 */
export default defineEventHandler(async (event) => {
  const campaignId = getQuery(event).campaignId;
  if (typeof campaignId !== "string" || !SAFE_ID_PATTERN.test(campaignId)) {
    setResponseStatus(event, 400);
    return { error: "Invalid campaign id" };
  }
  return getDecisionStore(LOCAL_TENANT).readDecisions(campaignId);
});
