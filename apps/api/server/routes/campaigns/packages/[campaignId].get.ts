import { SAFE_ID_PATTERN } from "@campaignfoundry/CampaignOrchestration";
import { getOutputStore } from "../../../lib/ports/index.js";

import { LOCAL_TENANT } from "../../../lib/tenant.js";
/**
 * GET /campaigns/packages/:campaignId — the persisted platform manifests of a
 * campaign's packages, read through the output store. 404 if none.
 */
export default defineEventHandler(async (event) => {
  const campaignId = String(getRouterParam(event, "campaignId"));
  if (!SAFE_ID_PATTERN.test(campaignId)) {
    setResponseStatus(event, 400);
    return { error: "Invalid campaign id" };
  }
  const platforms = await getOutputStore(LOCAL_TENANT).listPackageManifests(campaignId);
  if (platforms.length === 0) {
    setResponseStatus(event, 404);
    return { error: "No packages found" };
  }
  return { platforms };
});
