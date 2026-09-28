"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { BriefEditor } from "@/components/campaign/BriefEditor";
import { hasRecoverableDraft } from "@/components/campaign/editor-state";
import { useCreateCampaign } from "@/lib/create-campaign-context";

/**
 * PT-5c1 (D177) — `/brief/new` no longer starts a blank campaign itself: a
 * create is always `POST /campaigns` first (`create-campaign.ts`), landing
 * on `/brief/<campaignId>` (D178) — a blank editor only ever exists at a
 * route that already names a minted campaign (`hasVersion: false`,
 * `BriefEditor`'s own effect for that case).
 *
 * This route's one remaining job is W3's resume: `cf:draft:new` is the one
 * stable autosave key every unnamed editor used to share (H6), and a build
 * from before this lane can still have abandoned work sitting under it. With
 * nothing to resume, this opens the create dialog and sends the visitor to
 * the grid behind it — so a blank create still mints first, the way the
 * enumerated flow requires; with a recoverable draft, it renders the editor
 * here exactly as it always did, so the draft's own D11 recovery effect
 * finds it. The check runs in an effect, not in the initial render, because
 * `localStorage` does not exist on the server and a render-time read would
 * make the first client render disagree with it (the hydration trap
 * `Disclosure` documents elsewhere in this codebase).
 */
export default function NewBriefPage() {
  const router = useRouter();
  const { openCreateDialog } = useCreateCampaign();
  const [resuming, setResuming] = useState<boolean | null>(null);

  useEffect(() => {
    if (hasRecoverableDraft()) {
      setResuming(true);
      return;
    }
    setResuming(false);
    openCreateDialog();
    router.replace("/grid");
  }, [openCreateDialog, router]);

  if (resuming) return <BriefEditor />;
  return null;
}
