import { getBriefStore, getDraftStore } from "../../../lib/ports/index.js";
import { requestTenant } from "../../../lib/tenant.js";

/**
 * GET /campaigns/briefs/draft — the caller's own latest autosave draft
 * across every campaign in their org (PT-5d item 5, D173). Nested under
 * `briefs/` (not `/campaigns/draft`) so this route can never shadow a real
 * campaign named or slugged "draft" at `GET /campaigns/:id` — this lane owns
 * no reserved-id list to guard that the other way (PT-5e's `last-opened`
 * does). W3's resume prompt (`app/(shell)/brief/new/page.tsx`,
 * `CreateCampaignDialog.tsx`) calls this to decide whether to offer resuming
 * a draft, and which campaign to open if so. `{ latest: null }` when the
 * caller has none.
 *
 * Fix round item 1 (grok-4.7): a draft row surviving on a campaign the
 * caller can no longer see (team-hidden since it was taken — the migration
 * cascades only on campaign DELETE, never on a team change) is not this
 * caller's latest draft, whatever `updated_at` says — walk the caller's
 * drafts newest-first and answer the first whose campaign `campaignMeta`
 * still resolves for them, exactly the "hidden reads as missing" gate every
 * other `/campaigns/:id/*` route already uses. `{ latest: null }` either way
 * (no drafts at all, or every one of them now hidden) — the SAME 200 body,
 * never a 404, so a caller cannot tell a hidden draft existed from having
 * none.
 */
export default defineEventHandler(async (event) => {
  const scope = requestTenant(event);
  const drafts = await getDraftStore(scope).listDraftsByRecency(scope.userId);
  const briefs = getBriefStore(scope);
  for (const draft of drafts) {
    if (await briefs.campaignMeta(draft.campaignId)) {
      return { latest: draft };
    }
  }
  return { latest: null };
});
