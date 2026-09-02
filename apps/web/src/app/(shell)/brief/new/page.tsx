"use client";

import { BriefEditor } from "@/components/campaign/BriefEditor";

/**
 * The blank editor, as its own route. "This is a new brief" is a statement about the
 * URL, so it holds for as long as the user is here and nothing can quietly put the
 * last campaign back on screen (D37). A reload at this route also finds the draft it
 * left: the recovery draft is keyed to one stable key for the whole route (H6).
 */
export default function NewBriefPage() {
  return <BriefEditor />;
}
