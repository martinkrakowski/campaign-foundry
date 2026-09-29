"use client";

import { campaignRoute } from "@/lib/campaign-route";
import { useLastOpenedRedirect } from "@/lib/run-context";

/**
 * D37: the bare `/brief` route never renders an editor — the URL is the single source
 * of truth for which brief is open, and this route names none. It hands the visitor to
 * the brief they last opened, or, when there is none, to the grid and the picker.
 *
 * PT-5e (D173, D180): "the brief they last opened" is the server's per-user pointer
 * now, not a `localStorage` copy only that browser could read. A pointer to a campaign
 * that has since been deleted, or become hidden by team, reads as no pointer at all —
 * the server answers those two identically (D166) — so both land on the picker, and
 * nothing here can tell them apart.
 *
 * The redirect target is the editor's own route, `campaignRoute(id)`, which the
 * editor loads from the server exactly as it loads any campaign its route names.
 */
export default function BriefIndexPage() {
  useLastOpenedRedirect(campaignRoute);
  return null;
}
