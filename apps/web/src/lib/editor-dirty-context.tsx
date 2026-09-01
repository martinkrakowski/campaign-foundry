"use client";

import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import type { SectionId } from "@/components/campaign/sections";
import { createContext, useContext, useState, useCallback, type ReactNode, type RefObject } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/ui";

/**
 * D35: the editor's run-without-write handoff. While the editor is mounted and its
 * on-screen draft differs from the shell's brief, Generate cannot know which brief to
 * run — so the editor publishes this and Generate asks (the three-way confirm in
 * Header.tsx, which replaces the guard's prompt — one question, never two).
 *
 * The draft rides a stable ref the editor refreshes on every render, so the published
 * object never goes stale while the user keeps typing — and publishing stays a
 * dirty-transition event, not a per-keystroke churn of every provider consumer.
 *
 * The ref is typed non-nullable on purpose: the editor nulls it exactly when it
 * unpublishes the handoff, so while the handoff stands the draft always exists. The
 * null case is gone from the type rather than guarded downstream — the three-way
 * dialog reads it with no branch to ignore.
 */
export interface DraftRunHandoff {
  /** The freshest on-screen draft, read at press time (the handoff exists only while it differs). */
  draftRef: Readonly<RefObject<CampaignBrief>>;
  /**
   * The editor's verdict on its own draft: the first section that blocks a save, or
   * null while the draft would pass. A ref refreshed every render, exactly like
   * `draftRef` — the handoff is published on a differs-flip, so a plain value would
   * go stale the moment the user fixed (or broke) the field it named.
   */
  blockedRef: Readonly<RefObject<SectionId | null>>;
  /**
   * Refuse an invalid draft the way Save refuses it (GB-D3): mark the attempt,
   * reveal the first blocking section and hand it focus. Returns whether the draft
   * was refused; the caller speaks the wording where the user is.
   */
  refuseInvalid: () => boolean;
  /**
   * Persist the draft through the editor's own save path — validation, the refusal,
   * and conflict handling all belong to it. Resolves with the brief exactly as the
   * server stored it (what "Save and run" runs), or null when the save was refused;
   * the refusal is spoken by the editor, where the user is.
   */
  saveAndRun: () => Promise<CampaignBrief | null>;
}

interface EditorDirtyContextValue {
  isDirty: boolean;
  setDirty: (dirty: boolean) => void;
  guardedAction: (action: () => void) => boolean;
  guardedPush: (url: string) => boolean;
  /** The mounted editor's run-without-write handoff, or null (no differing draft). */
  draftRun: DraftRunHandoff | null;
  setDraftRun: (handoff: DraftRunHandoff | null) => void;
}

const EditorDirtyContext = createContext<EditorDirtyContextValue | null>(null);

export function EditorDirtyProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [isDirty, setIsDirty] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const [draftRun, setDraftRun] = useState<DraftRunHandoff | null>(null);

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
    <EditorDirtyContext.Provider value={{ isDirty, setDirty, guardedAction, guardedPush, draftRun, setDraftRun }}>
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
