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
 *
 * Fix round (bots) — `slug` rides along with `campaignId`: on Postgres
 * `campaignId` is the draft row's own uuid, but the caller's OWN editor
 * route can be reached either way (`/brief/<uuid>` or `/brief/<slug>`,
 * #613), so a uuid-only comparison against `pathname` never matches a
 * slug-reached route even when it names the SAME campaign — a real qodo
 * finding, since `campaignMeta` already resolves the slug here for the
 * visibility check, so answering it costs nothing extra.
 *
 * Fix round (bots) — Qodo, real: a visible candidate whose `baseRevision`
 * no longer matches the campaign's current revision (another save landed,
 * here or elsewhere, since the draft was taken) is not restorable —
 * `BriefEditor`'s own restore effect already refuses it on that same
 * mismatch. Answering it as "the latest draft" anyway is worse than
 * answering nothing: it is stuck at the top of `listDraftsByRecency`
 * forever (nothing else touches its `updated_at`), so `/brief/new` would
 * keep redirecting to a campaign whose draft can never actually restore,
 * and Create would keep offering a Resume that goes nowhere useful — for
 * every visit, not just one. Skipped here AND deleted (self-cleaning: nothing
 * else is guaranteed to visit that campaign's own route again to trigger the
 * restore effect's own cleanup), continuing to the next candidate.
 */
export default defineEventHandler(async (event) => {
  const scope = requestTenant(event);
  const draftStore = getDraftStore(scope);
  const drafts = await draftStore.listDraftsByRecency(scope.userId);
  const briefs = getBriefStore(scope);
  for (const draft of drafts) {
    const meta = await briefs.campaignMeta(draft.campaignId);
    if (!meta) continue;
    const stored = await draftStore.readDraft(draft.campaignId, scope.userId);
    if (!stored) continue;
    const currentRevision = (await briefs.getRevision(meta.slug)) ?? null;
    if (stored.baseRevision !== currentRevision) {
      await draftStore.deleteDraft(draft.campaignId, scope.userId);
      continue;
    }
    return { latest: { campaignId: draft.campaignId, slug: meta.slug } };
  }
  return { latest: null };
});
