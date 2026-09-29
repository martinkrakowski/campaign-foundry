import { errorMessage } from "@campaignfoundry/shared";
import { assertSafeId } from "../../../lib/load-brief.js";
import { getBriefStore, getDraftStore } from "../../../lib/ports/index.js";
import { requestTenant } from "../../../lib/tenant.js";

/**
 * GET /campaigns/:id/draft — the caller's own autosave draft for this
 * campaign (PT-5d, D173, D177). `:id` is a uuid or a slug (D178, D179):
 * `campaignMeta` resolves either shape itself, the same "known campaign"
 * gate every other `/campaigns/:id/*` route uses since PT-5c2 — a hidden and
 * a missing campaign answer the same 404. `{ draft: null }` (200) when the
 * campaign is known but this caller has no draft for it; drafts are per
 * (campaign, user), so another user's draft — or none at all — never shows
 * here. The user is `requestTenant(event).userId`, the session's own
 * identity, never a query parameter.
 */
export default defineEventHandler(async (event) => {
  let id: string;
  try {
    id = String(getRouterParam(event, "id"));
    assertSafeId(id, "Campaign id");
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: errorMessage(error) };
  }

  const scope = requestTenant(event);
  const meta = await getBriefStore(scope).campaignMeta(id);
  if (!meta) {
    setResponseStatus(event, 404);
    return { error: `Campaign "${id}" not found.` };
  }

  const draft = await getDraftStore(scope).readDraft(meta.campaignId, scope.userId);
  return { draft: draft ?? null };
});
