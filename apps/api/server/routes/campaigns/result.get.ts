import { campaignKnown } from "../../lib/ownership.js";
import { getBriefStore } from "../../lib/ports/index.js";
import { readReport } from "../../lib/report.js";
import { withAssetUrls } from "../../lib/signed-urls.js";
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
 *
 * Every row carries a `*Url` per asset on top of the report it always read
 * (PT-4f, D204) — a presigned GET under `s3`, today's output route on fs. **Not
 * one of them is minted before `campaignKnown` has answered**, and that ordering
 * is the whole tenancy of this route: the org and the campaign in every key are
 * the caller's own tenant's and its own resolve's, so a caller who may not see
 * this campaign never reaches the line that would ask the store to sign for it.
 */
export default defineEventHandler(async (event) => {
  const campaignId = getQuery(event).campaignId;
  // A present campaignId must be a single string. Repeated params yield string[] —
  // treat that (and any non-string, and absence) as no campaign → empty.
  if (typeof campaignId !== "string") return EMPTY;
  const scope = requestTenant(event);
  // A uuid ref resolves to its slug; a ref that does not resolve (a slug with
  // no campaign row yet — an unsaved draft) passes through unchanged, exactly
  // as it did before campaign refs existed. campaignKnown below still answers
  // 404 for a ref that is truly unknown either way. On fs the id IS the slug
  // (D179): skip the lookup entirely, same guard the hidden-campaign checks
  // elsewhere use, so this never performs a directory scan the route did not
  // make before.
  const briefs = getBriefStore(scope);
  const resolved = briefs.supportsTeams ? await briefs.resolveCampaign(campaignId) : undefined;
  const slug = resolved?.slug ?? campaignId;
  await campaignKnown(scope, slug, "report");
  const report = await readReport(scope, slug);
  // "Never ran" is answered before anything is signed: there are no rows to carry
  // a URL, so the revision is not read either.
  if (report === undefined) return EMPTY;
  // `resolved`'s OWN fields, handed on rather than resolved again — the slug is
  // what a render path starts with, and the uuid is what a key hangs under. Both
  // absent (`campaignId` undefined) under `s3` for a ref that resolved to no row,
  // and `withAssetUrls` then mints no `s3` URL at all rather than a key with
  // nowhere to live.
  return withAssetUrls(scope, report, { slug, campaignId: resolved?.campaignId });
});
