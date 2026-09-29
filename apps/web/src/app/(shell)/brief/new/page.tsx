"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { fetchLatestServerDraft } from "@/components/campaign/editor-state";
import { campaignRoute } from "@/lib/campaign-route";
import { useCreateCampaign } from "@/lib/create-campaign-context";

/**
 * PT-5c1 (D177) — `/brief/new` no longer starts a blank campaign itself: a
 * create is always `POST /campaigns` first (`create-campaign.ts`), landing
 * on `/brief/<campaignId>` (D178) — a blank editor only ever exists at a
 * route that already names a minted campaign (`hasVersion: false`,
 * `BriefEditor`'s own effect for that case).
 *
 * PT-5d item 5 — this route's one remaining job is W3's resume, now server-side:
 * `GET /campaigns/briefs/draft` answers the caller's own latest autosave draft
 * across every campaign (D173), which always names a real, already-minted
 * campaign — server drafts require one (`0014_draft.sql`'s FK) — so resuming
 * is a navigation to that campaign's own route, never a bare editor mounted
 * here. With no draft to resume, this opens the create dialog and sends the
 * visitor to the grid behind it, so a blank create still mints first, the way
 * the enumerated flow requires. The check runs in an effect, not the initial
 * render, so the fetch never runs during SSR and the first client render
 * matches the server's.
 *
 * Fix round (bots) — a failed lookup (`{ ok: false }`) falls through to the
 * SAME no-draft path as a genuine "none": blocking this route's one job
 * (landing somewhere) on a background check that failed would be worse than
 * the degraded case (offering a fresh create instead of a resume), and
 * nothing here risks data loss either way — the draft itself, if one exists,
 * is untouched on the server and still findable the next time this page (or
 * the create dialog) asks. `CreateCampaignDialog`'s OWN failure handling is
 * stricter (it refuses rather than minting) because ITS failure mode is
 * different: minting silently on a failed check there could orphan a real
 * draft behind a brand-new campaign, which landing here again cannot do.
 */
export default function NewBriefPage() {
  const router = useRouter();
  const { openCreateDialog } = useCreateCampaign();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await fetchLatestServerDraft();
      if (cancelled) return;
      if (result.ok && result.latest !== null) {
        router.replace(campaignRoute(result.latest.campaignId));
        return;
      }
      openCreateDialog();
      router.replace("/grid");
    })();
    return () => {
      cancelled = true;
    };
  }, [openCreateDialog, router]);

  return null;
}
