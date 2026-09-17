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
 * The hook's initial seed, exported so the server path can be tested
 * directly. A `"use client"` component (`BriefEditor.tsx`) is still
 * PRERENDERED ON THE SERVER at build time (Next's static generation of
 * `/brief/new`), and a `useState` initializer runs during that server
 * render — where there is no `window` at all. `readPresentation`
 * (`BriefEditor.tsx:99`) reads `window.localStorage` from a `useState`
 * initializer too and looks like a precedent for skipping a guard here, but
 * it only survives because its body is wrapped in `try { … } catch { return
 * "guided"; }` — the `ReferenceError` is thrown on the server and SWALLOWED
 * by that catch. That is safe by accident of exception handling, not
 * because the server never runs the code; a first attempt at this hook
 * copied the conclusion without the mechanism and broke the production
 * build (`ReferenceError: window is not defined` prerendering `/brief/new`).
 *
 * `false` is the safe direction when there is no viewport to read: no
 * `brief` is fed to the dock, nothing fetches, and the first real
 * `ResizeObserver` measurement (client-side only) corrects it once the page
 * hydrates.
 */
export function initialMinInlineSizeSeed(minPx: number): boolean {
  if (typeof window === "undefined") return false;
  return window.innerWidth >= minPx;
}

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
 * produced) — so the initial verdict is seeded from `window.innerWidth`
 * (`initialMinInlineSizeSeed`, above — read its comment for the server-side
 * half of this). The observed element can only be NARROWER than the
 * viewport (it shares the row with the shell's own sidebar), so a real,
 * client-side seed never under-reports "narrow"; at most it reports "wide
 * enough" one beat early, self-correcting on the element's first real
 * measurement. This also lets a test drive the seed deterministically by
 * setting `window.innerWidth` before mount, without a `ResizeObserver` stub
 * happy-dom cannot honour.
 *
 * A zero measurement is treated as "not laid out yet", never as a real
 * collapse to nothing, and keeps whatever verdict already stands.
 */
export function useMinInlineSize(ref: RefObject<HTMLElement | null>, minPx: number): boolean {
  const [atLeast, setAtLeast] = useState(() => initialMinInlineSizeSeed(minPx));

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

/**
 * The observed element's inline size in px, or `0` before anything has measured
 * it (TS1's fit).
 *
 * Same mechanism and the same caveats as {@link useMinInlineSize} above, which
 * this deliberately sits beside rather than reimplementing: `ResizeObserver`
 * never reports synchronously and does not fire at all under happy-dom, so `0`
 * is the honest answer in a test and on the first client paint. A caller must
 * therefore have a sane answer for `0` — the tape reads it as "not laid out
 * yet" and falls back to its minimum zoom — and must never treat it as a real
 * collapse to nothing. A zero MEASUREMENT is ignored for the same reason.
 *
 * There is no `window.innerWidth` seed here (unlike the hook above) on purpose:
 * that seed answers a yes/no question where being one beat early is harmless,
 * while a WIDTH taken from the viewport would be wrong by the width of the
 * shell's sidebar and the rail's own padding, and would show as a visible
 * re-fit on the first real measurement.
 */
export function useInlineWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0].contentRect.width;
      if (next === 0) return;
      setWidth(next);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}
