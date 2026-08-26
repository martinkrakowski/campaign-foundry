"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { useEditorDirty } from "./editor-dirty-context";

export function useGuardedNavigation() {
  const router = useRouter();
  const { isDirty } = useEditorDirty();

  const guardedPush = useCallback(
    (url: string) => {
      if (isDirty) {
        const confirmed = window.confirm(
          "You have unsaved changes. Are you sure you want to leave?"
        );
        if (!confirmed) {
          return;
        }
      }
      router.push(url);
    },
    [router, isDirty]
  );

  return { guardedPush, isDirty };
}
