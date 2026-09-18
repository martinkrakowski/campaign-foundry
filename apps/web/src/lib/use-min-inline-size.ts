"use client";

import { useEffect, useState, type RefObject } from "react";

/**
 * RS2 retired this module's other half. It held `PREVIEW_RAIL_MIN_INLINE_PX =
 * 896` and `useMinInlineSize` — the JS mirror of the preview rail's
 * `[@container(min-width:56rem)]` visibility query, observing the editor row the
 * query read. With the rail moved into the shell row behind the same VIEWPORT
 * `lg:` gate as the left sidebar, there is no container query to mirror and no
 * editor row to observe: `use-viewport-min-width.ts` answers the same question
 * about the viewport instead, and carries the two things that hook actually knew
 * (the server-prerender guard, and that the gate hides without unmounting, so the
 * WORK has to be stopped rather than only the result hidden).
 */

/**
 * The observed element's inline size in px, or `0` before anything has measured
 * it (TS1's fit).
 *
 * `ResizeObserver` never reports synchronously and does not fire at all under
 * happy-dom (no layout engine, so a border/content box is never produced), so
 * `0` is the honest answer in a test and on the first client paint. A caller
 * must therefore have a sane answer for `0` — the tape reads it as "not laid out
 * yet" and falls back to its minimum zoom — and must never treat it as a real
 * collapse to nothing. A zero MEASUREMENT is ignored for the same reason.
 *
 * There is no `window.innerWidth` seed here, unlike the viewport gate in
 * `use-viewport-min-width.ts`, and the difference is the point: that seed
 * answers a yes/no question where being one beat early is harmless, while a
 * WIDTH taken from the viewport would be wrong by the width of the shell's
 * sidebars and the rail's own padding, and would show as a visible re-fit on the
 * first real measurement. This is why the two hooks did not merge when the
 * container mirror retired.
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
