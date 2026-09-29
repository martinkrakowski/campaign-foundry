import { getDraftStore } from "../../../lib/ports/index.js";
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
 */
export default defineEventHandler(async (event) => {
  const scope = requestTenant(event);
  const latest = await getDraftStore(scope).latestDraft(scope.userId);
  return { latest: latest ?? null };
});
