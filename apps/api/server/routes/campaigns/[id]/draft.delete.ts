import { errorMessage } from "@campaignfoundry/shared";
import { assertSafeId } from "../../../lib/load-brief.js";
import { getBriefStore, getDraftStore } from "../../../lib/ports/index.js";
import { requestTenant } from "../../../lib/tenant.js";

/**
 * DELETE /campaigns/:id/draft — remove the caller's own autosave draft for
 * this campaign (PT-5d, D173). `BriefEditor` calls this after a successful
 * Save, beside its own local cleanup — the published `brief_version` is now
 * the source of truth, and a draft older than it must not resurface on the
 * next reload. A hidden and a missing campaign answer the same 404
 * (`campaignMeta`); an absent draft is a no-op, not an error, the same
 * idempotent shape every other revoke/delete route in this API takes.
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

  await getDraftStore(scope).deleteDraft(meta.campaignId, scope.userId);
  return { deleted: true };
});
