"use client";

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

export interface OutlineSection {
  id: string;
  label: string;
  errorCount: number;
}

/**
 * The editor's section list, published by the brief page while it is mounted and
 * rendered at the top of the shell's left bar. Lives in the shell so the sidebar —
 * and the mobile menu, which shares its content — can show it without knowing
 * anything about editor state.
 */
export interface EditorOutline {
  sections: OutlineSection[];
  /** Scroll the named section into view. */
  navigate: (id: string) => void;
}

interface EditorOutlineContextValue {
  outline: EditorOutline | null;
  setOutline: (outline: EditorOutline | null) => void;
}

const EditorOutlineContext = createContext<EditorOutlineContextValue | null>(null);

export function EditorOutlineProvider({ children }: { children: ReactNode }) {
  const [outline, setOutlineState] = useState<EditorOutline | null>(null);
  const setOutline = useCallback((next: EditorOutline | null) => setOutlineState(next), []);
  return <EditorOutlineContext.Provider value={{ outline, setOutline }}>{children}</EditorOutlineContext.Provider>;
}

export function useEditorOutline(): EditorOutlineContextValue {
  const context = useContext(EditorOutlineContext);
  if (!context) {
    throw new Error("useEditorOutline must be used within an EditorOutlineProvider");
  }
  return context;
}
