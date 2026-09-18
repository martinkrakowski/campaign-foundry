"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import { SidebarShell } from "@/components/shell/SidebarShell";

/** What the editor publishes: the slots themselves, read by whoever places them. */
interface EditorPanelSlots {
  /**
   * Editor sections that live in the left bar rather than the main column — today the
   * variation policy. The page publishes rendered elements while it is mounted: it
   * keeps the state, dispatch and validation, and the bar only places them, so the
   * sidebar needs to know nothing about editor state. The mobile menu shows them too,
   * since it shares the sidebar's content.
   */
  panels: ReactNode | null;
  /**
   * Panels that belong above everything else in the bar — the mode chooser, which is
   * the first decision a brief makes and so the first thing the bar shows (D4).
   * Same contract as `panels`: the page publishes rendered elements, the bar places them.
   */
  topPanels: ReactNode | null;
  /**
   * The RIGHT-hand column of the shell row — today the editor's preview rail
   * (RS2). Same contract as `panels`: the page publishes rendered elements while
   * it is mounted and the shell only places them, wearing `SidebarShell` so both
   * columns are one container.
   *
   * `label` travels with the content because the shell must NOT know what it is
   * placing. The aside is a second `complementary` landmark beside the left
   * sidebar's, so it needs an accessible name of its own — and a name the shell
   * hard-coded would either duplicate the rail's string or mislabel the next
   * view's right-hand panel. Presence of this value, and nothing else, is what
   * reveals the column (RS-D3): a route check can be right about the route and
   * wrong about the content, which is exactly the empty 256px strip that
   * shipped; presence cannot be.
   */
  rail: RailPanel | null;
  /**
   * Whether something is already placing the published panels. The sidebar registers
   * itself; `EditorPanelsOutlet` stands down when it has. A panel placed twice is two
   * live copies of the same control — every `getByRole` finds both, and a click lands
   * on one of them.
   */
  hasSink: boolean;
}

/** The setters, in a context of their own — see {@link useEditorPanelPublisher}. */
interface EditorPanelPublisher {
  setPanels: (panels: ReactNode | null) => void;
  setTopPanels: (panels: ReactNode | null) => void;
  setRail: (rail: RailPanel | null) => void;
  registerSink: () => () => void;
}

export interface RailPanel {
  /** The landmark's accessible name — see the `rail` slot above. */
  label: string;
  content: ReactNode;
}

const EditorPanelsContext = createContext<EditorPanelSlots | null>(null);

/**
 * **Why the setters are a SECOND context rather than four more fields on the
 * first.** A publisher that also subscribes re-renders itself whenever it
 * publishes, and with the rail (RS2) that stopped being merely a wasted render:
 * `BriefEditor` publishes an element built from a `useCallback` whose dependency
 * list it maintains by hand, so one unmemoised value in that list becomes
 * publish → context change → publisher re-render → new closure → publish, with
 * no fixed point. Measured, not feared: with the setters on the value context, a
 * mutation dropping `layerStack`'s `useMemo` span a worker at 100% CPU for 22
 * minutes instead of failing a render-count assertion in 14 seconds.
 *
 * Splitting the contexts makes that shape impossible rather than tested-for. The
 * publisher subscribes to nothing, so a publish cannot re-enter it; an unmemoised
 * prop is back to being what it always was — a defeated `memo`, caught by a
 * render count. It also removes the extra editor commit per gesture that the rail
 * introduced, and that the left bar's `panels` channel has paid since X32.
 *
 * This value is allocated once for the life of the provider, which is what makes
 * the above true — every setter inside it is a stable `useCallback`.
 */
const EditorPanelPublisherContext = createContext<EditorPanelPublisher | null>(null);

export function EditorPanelsProvider({ children }: { children: ReactNode }) {
  const [panels, setPanelsState] = useState<ReactNode | null>(null);
  const setPanels = useCallback((next: ReactNode | null) => setPanelsState(next), []);
  const [topPanels, setTopPanelsState] = useState<ReactNode | null>(null);
  const setTopPanels = useCallback((next: ReactNode | null) => setTopPanelsState(next), []);
  const [rail, setRailState] = useState<RailPanel | null>(null);
  const setRail = useCallback((next: RailPanel | null) => setRailState(next), []);
  const [sinks, setSinks] = useState(0);
  const registerSink = useCallback(() => {
    setSinks((n) => n + 1);
    return () => setSinks((n) => n - 1);
  }, []);
  const publisher = useMemo<EditorPanelPublisher>(
    () => ({ setPanels, setTopPanels, setRail, registerSink }),
    [setPanels, setTopPanels, setRail, registerSink],
  );
  return (
    <EditorPanelPublisherContext.Provider value={publisher}>
      <EditorPanelsContext.Provider value={{ panels, topPanels, rail, hasSink: sinks > 0 }}>
        {children}
      </EditorPanelsContext.Provider>
    </EditorPanelPublisherContext.Provider>
  );
}

/** Read the published slots. For whoever PLACES them — the sidebar, the shell row. */
export function useEditorPanels(): EditorPanelSlots {
  const context = useContext(EditorPanelsContext);
  if (!context) {
    throw new Error("useEditorPanels must be used within an EditorPanelsProvider");
  }
  return context;
}

/** Publish into the slots. For the editor, which must not subscribe to its own output. */
export function useEditorPanelPublisher(): EditorPanelPublisher {
  const context = useContext(EditorPanelPublisherContext);
  if (!context) {
    throw new Error("useEditorPanelPublisher must be used within an EditorPanelsProvider");
  }
  return context;
}

/**
 * Renders whatever the editor has published, in the bar's order. The real sidebar
 * places these itself; this is the same placement for anywhere else that needs to
 * show an editor's panels — notably tests, which would otherwise render an editor
 * whose mode chooser and policy panel exist but have nowhere to appear.
 *
 * The rail is placed here too, in the same container the shell row gives it
 * (`SidebarShell`), so a test that renders only the editor still finds the rail's
 * landmark — and finds it wearing the chrome that ships, not a bare div that
 * would let a container-query regression pass unseen.
 */
export function EditorPanelsOutlet(): ReactNode {
  const { panels, topPanels, rail, hasSink } = useEditorPanels();
  if (hasSink) return null;
  return (
    <>
      {topPanels}
      {panels}
      {rail ? <SidebarShell label={rail.label}>{rail.content}</SidebarShell> : null}
    </>
  );
}

/** The sidebar calls this to claim placement of the published panels. */
export function usePanelSink(): void {
  const { registerSink } = useEditorPanelPublisher();
  useEffect(() => registerSink(), [registerSink]);
}
