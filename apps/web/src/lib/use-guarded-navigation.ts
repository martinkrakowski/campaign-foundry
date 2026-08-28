"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { useEditorDirty } from "./editor-dirty-context";

export function useGuardedNavigation() {
  const router = useRouter();
  const { isDirty } = useEditorDirty();

  /** True when the navigation actually happened, so callers can hold their own UI open. */
  const guardedPush = useCallback(
    (url: string): boolean => {
      if (isDirty) {
        const confirmed = window.confirm(
          "You have unsaved changes. Are you sure you want to leave?"
        );
        if (!confirmed) {
          return false;
        }
      }
      router.push(url);
      return true;
    },
    [router, isDirty]
  );

  return { guardedPush, isDirty };
}
