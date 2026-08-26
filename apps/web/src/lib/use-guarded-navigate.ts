"use client";

import { useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import type { EditorState } from "@/components/campaign/editor-state";
import { isDirtySinceSave, isDirtySinceApply } from "@/components/campaign/editor-state";

export function useGuardedNavigate(
  state: EditorState,
  onDirty?: () => void,
) {
  const router = useRouter();
  const dirtyRef = useRef(false);

  // Update the dirty ref whenever the state changes
  useEffect(() => {
    dirtyRef.current = isDirty(state);
  }, [state]);

  // Handle beforeunload for tab close/reload
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  const guardedPush = useCallback(
    (url: string) => {
      if (dirtyRef.current) {
        if (onDirty) {
          onDirty();
        } else {
          const confirmed = window.confirm(
            "You have unsaved changes. Are you sure you want to leave?"
          );
          if (confirmed) {
            router.push(url);
          }
        }
      } else {
        router.push(url);
      }
    },
    [router, onDirty]
  );

  return { guardedPush };
}

export function isDirty(state: EditorState): boolean {
  return isDirtySinceSave(state) || isDirtySinceApply(state);
}
