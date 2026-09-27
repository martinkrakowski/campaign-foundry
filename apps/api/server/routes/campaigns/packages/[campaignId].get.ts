import { SAFE_ID_PATTERN } from "@campaignfoundry/CampaignOrchestration";
import { getBriefStore, getOutputStore } from "../../../lib/ports/index.js";
import { requestTenant } from "../../../lib/tenant.js";

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
  const scope = requestTenant(event);
  const briefs = getBriefStore(scope);
  // See result.get.ts: resolve a uuid to its slug, pass a slug through unchanged
  // (an unsaved draft has no campaign row yet); listPackageManifests still
  // answers empty for a ref that is genuinely unknown either way.
  const resolved = await briefs.resolveCampaign(campaignId);
  const slug = resolved?.slug ?? campaignId;
  if (briefs.supportsTeams && (await briefs.campaignVisibility(slug)) === "hidden") {
    setResponseStatus(event, 404);
    return { error: "No packages found" };
  }
  const platforms = await getOutputStore(scope).listPackageManifests(slug);
  if (platforms.length === 0) {
    setResponseStatus(event, 404);
    return { error: "No packages found" };
  }
  return { platforms };
});
