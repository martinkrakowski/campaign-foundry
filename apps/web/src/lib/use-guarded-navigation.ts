"use client";

import { useEditorDirty } from "./editor-dirty-context";

/**
 * Guarded navigation hook (W10.3).
 * Intercepts transitions when the editor has unsaved changes, prompting via ConfirmDialog.
 * Returns `guardedPush` (returns boolean indicating if navigation immediately completed),
 * `guardedAction` (the whole-gesture form) and `isDirty`.
 *
 * SG9 dropped D35's `draftRun` — the editor's run-without-write handoff. It existed so a
 * Generate living OUTSIDE the editor could ask which brief to run; the verb is inside the
 * editor now (SG-D10) and hands `execute` the on-screen projection, so there is no second
 * candidate and nothing to publish.
 */
export function useGuardedNavigation() {
  const { isDirty, guardedPush, guardedAction } = useEditorDirty();
  return { guardedPush, guardedAction, isDirty };
}
