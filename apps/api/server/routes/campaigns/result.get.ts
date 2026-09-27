import { campaignKnown } from "../../lib/ownership.js";
import { getBriefStore } from "../../lib/ports/index.js";
import { readReport } from "../../lib/report.js";
import { requestTenant } from "../../lib/tenant.js";

/** The empty "no run yet" result the UI treats as "never ran". */
const EMPTY = { halted: false, assets: [], log: null };

/**
 * GET /campaigns/result?campaignId= — a campaign's persisted report.
 *
 * Returns that brief's own report, so switching briefs in the UI reloads the right
 * run rather than the most recent one. An absent, unknown, unsafe or repeated id
 * yields the empty result. There is no "latest run" answer any more (PT-0a): the
 * global pointer served whichever campaign ran last to any caller, which has no
 * meaning once runs belong to a tenant, and the web app always names its campaign.
 */
export default defineEventHandler(async (event) => {
  const campaignId = getQuery(event).campaignId;
  // A present campaignId must be a single string. Repeated params yield string[] —
  // treat that (and any non-string, and absence) as no campaign → empty.
  if (typeof campaignId !== "string") return EMPTY;
  const scope = requestTenant(event);
  // A uuid ref resolves to its slug; a ref that does not resolve (a slug with
  // no campaign row yet — an unsaved draft, D179 on fs) passes through
  // unchanged, exactly as it did before campaign refs existed. campaignKnown
  // below still answers 404 for a ref that is truly unknown either way.
  const resolved = await getBriefStore(scope).resolveCampaign(campaignId);
  const slug = resolved?.slug ?? campaignId;
  await campaignKnown(scope, slug, "report");
  const report = await readReport(scope, slug);
  return report === undefined ? EMPTY : report;
});
