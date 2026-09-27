import { errorMessage } from "@campaignfoundry/shared";
import { assertSafeId } from "../../../lib/load-brief.js";
import { InvalidCopyPoolError, readPool } from "../../../lib/pools.js";
import { getBriefStore } from "../../../lib/ports/index.js";
import { requestTenant } from "../../../lib/tenant.js";

/**
 * GET /campaigns/pools/:briefId — return the persisted copy pool with the
 * revision of the bytes it was read from, or 404. A hand-edited file that is
 * not a pool is a 422 naming the file and the problem. The revision is what
 * PATCH sends back to write conditionally (API E1.0, for pools).
 */
export default defineEventHandler(async (event) => {
  let briefId: string;
  try {
    briefId = String(getRouterParam(event, "briefId"));
    assertSafeId(briefId, "briefId");
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: errorMessage(error) };
  }

  const scope = requestTenant(event);
  const briefs = getBriefStore(scope);
  // See result.get.ts: resolve a uuid to its slug, pass a slug through unchanged
  // (an unsaved draft has no campaign row yet — a pool can be curated before a
  // brief is saved, pools/copy.post.ts's inline-brief path); readPool below
  // still answers undefined for a ref that is genuinely unknown either way.
  const resolved = await briefs.resolveCampaign(briefId);
  const slug = resolved?.slug ?? briefId;
  if (briefs.supportsTeams && (await briefs.campaignVisibility(slug)) === "hidden") {
    setResponseStatus(event, 404);
    return { error: `Headline pool for brief "${briefId}" not found.` };
  }

  let stored;
  try {
    stored = await readPool(scope, slug);
  } catch (error) {
    if (!(error instanceof InvalidCopyPoolError)) throw error;
    setResponseStatus(event, 422);
    return { error: error.message };
  }
  if (!stored) {
    setResponseStatus(event, 404);
    return { error: `Headline pool for brief "${briefId}" not found.` };
  }
  return { pool: stored.pool, revision: stored.revision };
});
