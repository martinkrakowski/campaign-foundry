"use client";

import { BriefEditor } from "@/components/campaign/BriefEditor";

/**
 * The same editor, started empty. A route rather than a button's side effect: "this is
 * a new brief" then holds for as long as the user is here, so nothing can quietly put
 * the last campaign back on screen.
 */
export default function NewBriefPage() {
  return <BriefEditor blank />;
}
