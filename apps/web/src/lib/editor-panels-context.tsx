"use client";

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

interface EditorPanelsContextValue {
  /**
   * Editor sections that live in the left bar rather than the main column — today the
   * variation policy. The page publishes rendered elements while it is mounted: it
   * keeps the state, dispatch and validation, and the bar only places them, so the
   * sidebar needs to know nothing about editor state. The mobile menu shows them too,
   * since it shares the sidebar's content.
   */
  panels: ReactNode | null;
  setPanels: (panels: ReactNode | null) => void;
}

const EditorPanelsContext = createContext<EditorPanelsContextValue | null>(null);

export function EditorPanelsProvider({ children }: { children: ReactNode }) {
  const [panels, setPanelsState] = useState<ReactNode | null>(null);
  const setPanels = useCallback((next: ReactNode | null) => setPanelsState(next), []);
  return <EditorPanelsContext.Provider value={{ panels, setPanels }}>{children}</EditorPanelsContext.Provider>;
}

export function useEditorPanels(): EditorPanelsContextValue {
  const context = useContext(EditorPanelsContext);
  if (!context) {
    throw new Error("useEditorPanels must be used within an EditorPanelsProvider");
  }
  return context;
}
