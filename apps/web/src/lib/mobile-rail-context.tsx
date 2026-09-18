"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { RAIL_VIEWPORT_MIN_PX, useViewportMinWidth } from "./use-viewport-min-width";

interface MobileRailValue {
  /** True while the operator has asked to see the rail below the breakpoint. */
  readonly open: boolean;
  readonly openRail: () => void;
  readonly closeRail: () => void;
}

const MobileRailContext = createContext<MobileRailValue | null>(null);

/**
 * Whether the preview rail has been summoned below the `lg` breakpoint (SG11).
 *
 * **Why a context and not a prop.** The control that opens it lives in
 * `MobileMenu`, which `Header` renders; the rail itself lives in the shell row.
 * Threading a prop between them means editing `Header.tsx` — which SG9 is about
 * to rewrite — for a value both ends can simply ask for. Nothing else needs it,
 * so it is its own context rather than a new field on `editor-panels-context`,
 * whose two halves (slots and publisher) exist to keep rendered content flowing
 * one way; this is view state flowing the other.
 *
 * **It closes itself above the breakpoint**, and that is the load-bearing part
 * rather than tidiness. `open` decides which of two sites renders the rail's
 * elements, and they must be mutually exclusive — two mounts would duplicate
 * every `id` inside the rail and break the `aria-controls` pairs it builds. A
 * viewport that grows past `lg` while the overlay is up would otherwise leave
 * the shell column rendering the rail *and* the overlay still open. Derived
 * here, so no caller can forget.
 */
export function MobileRailProvider({ children }: { children: ReactNode }) {
  const [requested, setRequested] = useState(false);
  const roomForRail = useViewportMinWidth(RAIL_VIEWPORT_MIN_PX);

  const openRail = useCallback(() => setRequested(true), []);
  const closeRail = useCallback(() => setRequested(false), []);

  const value = useMemo<MobileRailValue>(
    // Not `requested` on its own: at `lg` and above the rail has a column of its
    // own, so a stale request must not also open the overlay.
    () => ({ open: requested && !roomForRail, openRail, closeRail }),
    [requested, roomForRail, openRail, closeRail],
  );

  return <MobileRailContext.Provider value={value}>{children}</MobileRailContext.Provider>;
}

export function useMobileRail(): MobileRailValue {
  const ctx = useContext(MobileRailContext);
  if (ctx === null) throw new Error("useMobileRail must be used within a MobileRailProvider");
  return ctx;
}
