import { SAFE_ID_PATTERN } from "@campaignfoundry/CampaignOrchestration";
import { getRunningJobId } from "../../../lib/jobs.js";
import { CampaignNotFoundError, resolveCampaignRef } from "../../../lib/ownership.js";
import { getBriefStore } from "../../../lib/ports/index.js";
import { requestTenant } from "../../../lib/tenant.js";

/**
 * GET /campaigns/jobs?campaignId= — look up the job currently running for a campaign.
 * Returns { jobId } when a run holds the campaign; 404 when none does; 400 for an
 * invalid or missing campaign id.
 */
export default defineEventHandler(async (event) => {
  const campaignId = getQuery(event).campaignId;
  if (typeof campaignId !== "string" || !SAFE_ID_PATTERN.test(campaignId)) {
    setResponseStatus(event, 400);
    return { error: "Invalid campaign id" };
  }
  const scope = requestTenant(event);
  let slug: string;
  try {
    slug = await resolveCampaignRef(scope, campaignId);
  } catch (error) {
    if (error instanceof CampaignNotFoundError) {
      setResponseStatus(event, 404);
      return { error: "No running job for campaign" };
    }
    throw error;
  }
  const briefs = getBriefStore(scope);
  if (briefs.supportsTeams && (await briefs.campaignVisibility(slug)) === "hidden") {
    setResponseStatus(event, 404);
    return { error: "No running job for campaign" };
  }
  const jobId = await getRunningJobId(scope, slug);
  if (!jobId) {
    setResponseStatus(event, 404);
    return { error: "No running job for campaign" };
  }
  return { jobId };
});
