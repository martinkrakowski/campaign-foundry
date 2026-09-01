"use client";

import { useEditorDirty } from "./editor-dirty-context";

/**
 * Guarded navigation hook (W10.3).
 * Intercepts transitions when the editor has unsaved changes, prompting via ConfirmDialog.
 * Returns `guardedPush` (returns boolean indicating if navigation immediately completed), `isDirty`,
 * and D35's `draftRun` — the mounted editor's run-without-write handoff, which Generate turns
 * into its three-way question.
 */
export function useGuardedNavigation() {
  const { isDirty, guardedPush, guardedAction, draftRun } = useEditorDirty();
  return { guardedPush, guardedAction, isDirty, draftRun };
}
