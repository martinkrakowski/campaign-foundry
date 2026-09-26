import { SAFE_ID_PATTERN } from "@campaignfoundry/CampaignOrchestration";
import { getRunningJobId } from "../../../lib/jobs.js";
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
  const jobId = await getRunningJobId(requestTenant(event), campaignId);
  if (!jobId) {
    setResponseStatus(event, 404);
    return { error: "No running job for campaign" };
  }
  return { jobId };
});
