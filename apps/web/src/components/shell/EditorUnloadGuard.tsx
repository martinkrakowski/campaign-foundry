"use client";

import { useEffect } from "react";
import { useEditorDirty } from "@/lib/editor-dirty-context";

/**
 * D185 — the shell's warning before the tab goes away with unsaved work in it.
 *
 * **One listener, in the shell, not one per feature.** The in-app guard
 * (`use-guarded-navigation`) covers a route change inside the SPA; nothing
 * covered the tab close or the reload, which is where a brief the operator had
 * not saved was simply lost. The state it reads is the only place the three
 * kinds of unsaved work meet: the editor publishes `isDirty`,
 * `hasPendingWrite` and `hasFailedWrite` into `EditorDirtyContext`, and a
 * second listener in the editor would be a second copy of the same decision.
 *
 * **Registered only while there is something to lose, and that is a
 * requirement rather than an optimisation.** A `beforeunload` listener that is
 * present at all makes the page ineligible for the back/forward cache in most
 * browsers, so an always-on one would trade away instant restores for a
 * warning nobody reads on a clean editor. Hence the effect's early return: no
 * listener, no cost, and the "no listener when clean" half is testable.
 *
 * **`preventDefault()` AND `returnValue`.** The prompt is the browser's, and
 * its text is not ours to write — `returnValue` is the legacy half of the same
 * signal and older engines honour only that one, so a handler that sets just
 * the modern half is silently inert there.
 */
export function EditorUnloadGuard(): null {
  const { isDirty, hasPendingWrite, hasFailedWrite } = useEditorDirty();
  const armed = isDirty || hasPendingWrite || hasFailedWrite;

  useEffect(() => {
    if (!armed) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // An empty string, not a message: every current browser ignores the text
      // and shows its own, and a non-empty legacy value is what some of them
      // use to decide the dialog is worth showing at all.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [armed]);

  return null;
}
