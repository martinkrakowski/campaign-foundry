"use client";

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";

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
  /**
   * Panels that belong above everything else in the bar — the mode chooser, which is
   * the first decision a brief makes and so the first thing the bar shows (D4).
   * Same contract as `panels`: the page publishes rendered elements, the bar places them.
   */
  topPanels: ReactNode | null;
  setTopPanels: (panels: ReactNode | null) => void;
  /**
   * Whether something is already placing the published panels. The sidebar registers
   * itself; `EditorPanelsOutlet` stands down when it has. A panel placed twice is two
   * live copies of the same control — every `getByRole` finds both, and a click lands
   * on one of them.
   */
  hasSink: boolean;
  registerSink: () => () => void;
}

const EditorPanelsContext = createContext<EditorPanelsContextValue | null>(null);

export function EditorPanelsProvider({ children }: { children: ReactNode }) {
  const [panels, setPanelsState] = useState<ReactNode | null>(null);
  const setPanels = useCallback((next: ReactNode | null) => setPanelsState(next), []);
  const [topPanels, setTopPanelsState] = useState<ReactNode | null>(null);
  const setTopPanels = useCallback((next: ReactNode | null) => setTopPanelsState(next), []);
  const [sinks, setSinks] = useState(0);
  const registerSink = useCallback(() => {
    setSinks((n) => n + 1);
    return () => setSinks((n) => n - 1);
  }, []);
  return (
    <EditorPanelsContext.Provider value={{ panels, setPanels, topPanels, setTopPanels, hasSink: sinks > 0, registerSink }}>
      {children}
    </EditorPanelsContext.Provider>
  );
}

export function useEditorPanels(): EditorPanelsContextValue {
  const context = useContext(EditorPanelsContext);
  if (!context) {
    throw new Error("useEditorPanels must be used within an EditorPanelsProvider");
  }
  return context;
}

/**
 * Renders whatever the editor has published, in the bar's order. The real sidebar
 * places these itself; this is the same placement for anywhere else that needs to
 * show an editor's panels — notably tests, which would otherwise render an editor
 * whose mode chooser and policy panel exist but have nowhere to appear.
 */
export function EditorPanelsOutlet(): ReactNode {
  const { panels, topPanels, hasSink } = useEditorPanels();
  if (hasSink) return null;
  return (
    <>
      {topPanels}
      {panels}
    </>
  );
}

/** The sidebar calls this to claim placement of the published panels. */
export function usePanelSink(): void {
  const { registerSink } = useEditorPanels();
  useEffect(() => registerSink(), [registerSink]);
}
