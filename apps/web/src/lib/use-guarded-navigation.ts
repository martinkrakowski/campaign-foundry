"use client";

import { useEditorDirty } from "./editor-dirty-context";

/**
 * Guarded navigation hook (W10.3).
 * Intercepts transitions when the editor has unsaved changes, prompting via ConfirmDialog.
 * Returns `guardedPush` (returns boolean indicating if navigation immediately completed) and `isDirty`.
 */
export function useGuardedNavigation() {
  const { isDirty, guardedPush, guardedAction } = useEditorDirty();
  return { guardedPush, guardedAction, isDirty };
}
