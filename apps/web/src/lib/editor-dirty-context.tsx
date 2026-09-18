"use client";

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/ui";

interface EditorDirtyContextValue {
  isDirty: boolean;
  setDirty: (dirty: boolean) => void;
  guardedAction: (action: () => void) => boolean;
  guardedPush: (url: string) => boolean;
}

const EditorDirtyContext = createContext<EditorDirtyContextValue | null>(null);

export function EditorDirtyProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [isDirty, setIsDirty] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

  const setDirty = useCallback((dirty: boolean) => {
    setIsDirty(dirty);
  }, []);

  const guardedAction = useCallback(
    (action: () => void): boolean => {
      if (isDirty) {
        // Prompt once, never stack (DESIGN.md §5)
        setPendingAction((prev) => prev ?? (() => action()));
        return false;
      }
      action();
      return true;
    },
    [isDirty],
  );

  const guardedPush = useCallback(
    (url: string): boolean => {
      return guardedAction(() => router.push(url));
    },
    [guardedAction, router],
  );

  const handleConfirm = useCallback(() => {
    const action = pendingAction;
    setPendingAction(null);
    action?.();
  }, [pendingAction]);

  const handleClose = useCallback(() => {
    setPendingAction(null);
  }, []);

  return (
    <EditorDirtyContext.Provider value={{ isDirty, setDirty, guardedAction, guardedPush }}>
      {children}
      <ConfirmDialog
        open={pendingAction !== null}
        onConfirm={handleConfirm}
        onClose={handleClose}
      />
    </EditorDirtyContext.Provider>
  );
}

export function useEditorDirty() {
  const context = useContext(EditorDirtyContext);
  if (!context) {
    throw new Error("useEditorDirty must be used within an EditorDirtyProvider");
  }
  return context;
}
