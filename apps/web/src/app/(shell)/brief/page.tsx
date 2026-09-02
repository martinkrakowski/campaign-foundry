"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { BRIEF_KEY, isStoredBrief } from "@/lib/run-context";
import { SAFE_ID_PATTERN } from "@/components/campaign/validate";

/**
 * D37: the bare `/brief` route never renders an editor — the URL is the single source
 * of truth for which brief is open, and this route names none. It hands the visitor to
 * the brief they last opened (the one thing `cf:brief` still earns) or, when no
 * last-opened brief is recorded, to the grid.
 */
export default function BriefIndexPage() {
  const router = useRouter();
  useEffect(() => {
    let id: string | undefined;
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(BRIEF_KEY) ?? "null");
      if (isStoredBrief(parsed)) id = parsed.id;
    } catch {
      // Unreadable storage is the same as no record: there is no brief to offer.
    }
    // SAFE_ID_PATTERN is the one rule a brief id answers to (the same one the
    // Save-as backstop and the [id] route enforce): a malformed id cannot name a
    // brief, so it is refused here rather than sent to a route that cannot load it.
    if (id !== undefined && SAFE_ID_PATTERN.test(id)) router.replace(`/brief/${id}`);
    else router.replace("/grid");
  }, [router]);
  return null;
}
