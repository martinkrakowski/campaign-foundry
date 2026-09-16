"use client";

import { useEffect, useState, type RefObject } from "react";

/**
 * 56rem at the shell's 16px root — the same number the rail's own
 * `[@container(min-width:56rem)]:flex` class hard-codes (`BriefEditor.tsx`).
 * One constant so CSS and JS cannot drift apart silently; if the CSS
 * breakpoint ever changes, this must change with it (nothing enforces that
 * automatically — grep both sites).
 */
export const PREVIEW_RAIL_MIN_INLINE_PX = 896;

/**
 * The JS-side mirror of a CSS `@container(min-width: …)` query (CC1/CC2).
 * The rail's container query is CSS-only visibility: the element stays
 * mounted and anything it does — a network fetch, most of all — keeps
 * running while it is hidden. This hook answers the same "is there room"
 * question in script, so a caller can stop the WORK, not only hide the
 * result.
 *
 * `ResizeObserver` never reports synchronously, and does not fire at all
 * under happy-dom (no real layout engine, so a border/content box is never
 * produced) — so the initial verdict is seeded from `window.innerWidth`.
 * The observed element can only be NARROWER than the viewport (it shares the
 * row with the shell's own sidebar), so the seed never under-reports
 * "narrow"; at most it reports "wide enough" one beat early, self-correcting
 * on the element's first real measurement. This also lets a test drive the
 * seed deterministically by setting `window.innerWidth` before mount,
 * without a `ResizeObserver` stub happy-dom cannot honour.
 *
 * A zero measurement is treated as "not laid out yet", never as a real
 * collapse to nothing, and keeps whatever verdict already stands.
 */
export function useMinInlineSize(ref: RefObject<HTMLElement | null>, minPx: number): boolean {
  // No `typeof window` SSR guard: this hook is only ever called from
  // `"use client"` editor chrome (`BriefEditor.tsx`), which the rest of that
  // file already assumes has `window` (`readPresentation`/`readRailView`
  // read `window.localStorage` directly, guarding only against the STORAGE
  // API being unavailable, never against `window` itself being absent).
  const [atLeast, setAtLeast] = useState(() => window.innerWidth >= minPx);

  useEffect(() => {
    const el = ref.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      // The spec guarantees at least one entry per observed target per
      // callback — there is nothing else in this array to read, so no
      // `undefined` guard here is a branch a test could honestly justify.
      // `contentRect`, not `contentBoxSize`: universally supported (every
      // polyfill honours it) and this hook only ever needs one number.
      const width = entries[0].contentRect.width;
      if (width === 0) return;
      setAtLeast(width >= minPx);
    });
    observer.observe(el);
    return () => observer.disconnect();
    // `minPx` is a caller-supplied constant in every call site this hook has
    // today (`PREVIEW_RAIL_MIN_INLINE_PX`) — re-observing on a changed value
    // would be a dead branch no test could honestly justify, and the
    // react-hooks lint plugin is not wired into this project's eslint config.
  }, [ref]);

  return atLeast;
}
