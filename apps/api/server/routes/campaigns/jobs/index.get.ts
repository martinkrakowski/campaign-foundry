import { SAFE_ID_PATTERN } from "@campaignfoundry/CampaignOrchestration";
import { getRunningJobId } from "../../../lib/jobs.js";
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
  const briefs = getBriefStore(scope);
  // See result.get.ts: resolve a uuid to its slug on a backend that has one
  // (D178), pass a slug through unchanged otherwise — an unsaved draft has no
  // campaign row yet, and on fs the id IS the slug (D179), so no lookup runs
  // there. A ref that is genuinely unknown still 404s below — no job is ever
  // running under a key nothing was ever enqueued with.
  const resolved = briefs.supportsTeams ? await briefs.resolveCampaign(campaignId) : undefined;
  const slug = resolved?.slug ?? campaignId;
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
