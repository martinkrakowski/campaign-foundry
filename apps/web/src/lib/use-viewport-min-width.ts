"use client";

import { useEffect, useState } from "react";

/**
 * Tailwind's `lg` breakpoint in px — the viewport width at which the shell's
 * sidebars appear (`SidebarShell`'s `lg:flex`).
 *
 * RS2/RS-D4 — this replaces `PREVIEW_RAIL_MIN_INLINE_PX = 896`, which mirrored
 * the preview rail's old `[@container(min-width:56rem)]` query. That query's
 * container was `viewport − 368px`, so it resolved to 1264px of viewport while
 * the left sidebar appeared at 1024px; the rail now wears the same VIEWPORT gate
 * as the left sidebar, and this constant mirrors that gate instead.
 *
 * Nothing in the CSS pipeline enforces the agreement, so it is not left to a
 * comment: `rail-in-shell.test.tsx` compiles the rail's own class string with the
 * project's Tailwind config, reads the `min-width` out of the emitted `@media`
 * rule, and asserts it equals this number. Either side drifting alone fails
 * exactly that test — the same derivation CC2's review asked for when the 56rem
 * query and its 896 mirror were asserted independently.
 */
export const RAIL_VIEWPORT_MIN_PX = 1024;

/**
 * The seed, exported so the server path can be tested directly.
 *
 * A `"use client"` component (`BriefEditor.tsx`) is still PRERENDERED ON THE
 * SERVER at build time (Next's static generation of `/brief/new`), and a
 * `useState` initializer runs during that server render — where there is no
 * `window` at all. This guard is not defensive habit: the container-query
 * predecessor of this hook broke the production build (`ReferenceError: window
 * is not defined` prerendering `/brief/new`) for want of it, after a first
 * attempt copied `readPresentation`'s apparent precedent without its mechanism —
 * that one only survives because its body sits inside `try { … } catch { return
 * "guided"; }`, so the server's `ReferenceError` is swallowed. Safe by accident
 * of exception handling is not safe.
 *
 * `false` is the right direction with no viewport to read: no `brief` is fed to
 * the dock, nothing fetches, and the first client render corrects it.
 */
export function viewportAtLeast(minPx: number): boolean {
  if (typeof window === "undefined") return false;
  return window.innerWidth >= minPx;
}

/**
 * The JS-side mirror of a CSS viewport breakpoint (CC1/CC2's contract, carried
 * through RS2's move).
 *
 * The gate is CSS-only visibility: `hidden lg:flex` hides the rail without
 * unmounting it — which every mount-count invariant in the editor depends on
 * (D43) — so anything the rail *does* while hidden, a network fetch most of all,
 * keeps happening. This hook answers the same "is there room" question in
 * script, so a caller can stop the WORK and not only hide the result.
 *
 * `resize`, not `ResizeObserver`: the question is about the viewport, which is
 * exactly what `resize` reports, and unlike `ResizeObserver` it needs no layout
 * engine — happy-dom produces no box, so an observer never fires there at all.
 * `matchMedia` would answer the same question, but its listener support is the
 * part happy-dom implements least, and a test that cannot drive the gate proves
 * nothing about it.
 *
 * The effect reads once before subscribing, which is what corrects the server's
 * `false` after hydration; when the seed was already right that write is a
 * same-value `setState` and React bails without a re-render.
 */
export function useViewportMinWidth(minPx: number): boolean {
  const [atLeast, setAtLeast] = useState(() => viewportAtLeast(minPx));

  useEffect(() => {
    const read = () => setAtLeast(viewportAtLeast(minPx));
    read();
    window.addEventListener("resize", read);
    return () => window.removeEventListener("resize", read);
  }, [minPx]);

  return atLeast;
}
