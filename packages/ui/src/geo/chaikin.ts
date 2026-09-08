// Ported verbatim from the inspiration mockup (plan 2026-09-07_graphics-and-the-world-map,
// F4): framework-free geometry on a 960×500 equirectangular-ish grid. These are the
// fixtures for the unit tests as well as the source data — do not redraw the numbers.

export type Pt = readonly [number, number];

/** Chaikin corner-cutting — two passes give every landmass the same designed roundness. */
export function chaikin(pts: readonly Pt[], it = 2): Pt[] {
  let cur: Pt[] = [...pts];
  for (let n = 0; n < it; n++) {
    const out: Pt[] = [cur[0]];
    for (let i = 0; i < cur.length - 1; i++) {
      const [x1, y1] = cur[i], [x2, y2] = cur[i + 1];
      out.push([x1 * .75 + x2 * .25, y1 * .75 + y2 * .25], [x1 * .25 + x2 * .75, y1 * .25 + y2 * .75]);
    }
    out.push(cur[cur.length - 1]);
    cur = out;
  }
  return cur;
}

export const polyPath = (pts: readonly Pt[]): string =>
  "M" + chaikin(pts).map((p) => p[0].toFixed(1) + " " + p[1].toFixed(1)).join("L") + "Z";
