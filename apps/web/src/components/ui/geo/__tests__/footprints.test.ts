import { describe, test, expect } from "vitest";
import {
  centroid,
  dotMatrix,
  DOT_STEP,
  GRATICULE_HORIZONTALS,
  GRATICULE_VERTICALS,
  MAP_HEIGHT,
  MAP_WIDTH,
  REGION_FOOTPRINTS,
  type Footprint,
} from "../footprints";
import { EUR, NA } from "../polygons";
import { pip } from "../pip";
import type { Pt } from "../chaikin";

// The vocabulary of §2.3, in REGION_OPTIONS order. `Other…` is a free-text escape
// and deliberately has no footprint here.
const VALUES = ["GLOBAL", "EU", "DE", "UK", "US", "APAC"];

function footprint(value: string): Footprint {
  const found = REGION_FOOTPRINTS.find((f) => f.value === value);
  expect(found, `no footprint for ${value}`).toBeDefined();
  return found as Footprint;
}

describe("REGION_FOOTPRINTS", () => {
  test("carries the six vocabulary values in REGION_OPTIONS order", () => {
    expect(REGION_FOOTPRINTS.map((f) => f.value)).toEqual(VALUES);
  });

  test("every footprint is non-empty and hubless GLOBAL sits alone", () => {
    for (const f of REGION_FOOTPRINTS) {
      expect(f.polys.length, `${f.value} has no polygons`).toBeGreaterThan(0);
    }
    expect(footprint("GLOBAL").hub).toBeUndefined();
    for (const value of VALUES.slice(1)) {
      expect(footprint(value).hub, `${value} has no hub`).toBeDefined();
    }
  });

  test("the composed footprints use the §2.3 polygons", () => {
    // EU is the continental bloc plus the Nordics — the mockup's EUR and SCAN.
    expect(footprint("EU").polys[0]).toBe(EUR);
    expect(footprint("EU").polys.length).toBe(2);
    // APAC: continental ASIA plus the fifteen island polygons.
    expect(footprint("APAC").polys.length).toBe(15);
    // GLOBAL paints every landmass: the APAC islands plus the Atlantic hemisphere.
    expect(footprint("GLOBAL").polys.length).toBe(24);
  });

  test("DE and US are the two new polygons, coarse anchor lists on the parent grid", () => {
    const de = footprint("DE").polys[0] as readonly Pt[];
    const us = footprint("US").polys[0] as readonly Pt[];
    expect(de.length).toBeGreaterThanOrEqual(8);
    expect(de.length).toBeLessThanOrEqual(10);
    expect(us.length).toBeGreaterThanOrEqual(8);
    expect(us.length).toBeLessThanOrEqual(11);
  });

  test("every DE/US vertex and sampled edge point is inside its parent (no outline in the sea)", () => {
    const de = footprint("DE").polys[0] as readonly Pt[];
    const us = footprint("US").polys[0] as readonly Pt[];
    const fractions = [0.25, 0.5, 0.75];
    const outline = (poly: readonly Pt[]): Pt[] => {
      const pts: Pt[] = [];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i] as Pt;
        const b = poly[(i + 1) % poly.length] as Pt;
        pts.push(a);
        for (const t of fractions) {
          pts.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
        }
      }
      return pts;
    };
    expect(outline(de).filter(([x, y]) => !pip(x, y, EUR))).toEqual([]);
    expect(outline(us).filter(([x, y]) => !pip(x, y, NA))).toEqual([]);
  });

  test("the delegated hubs are the mockup's own and the drawn ones are their centroids", () => {
    expect(footprint("EU").hub).toEqual([540, 235]);
    expect(footprint("US").hub).toEqual([240, 108]);
    expect(footprint("APAC").hub).toEqual([790, 140]);
    const de = footprint("DE").polys[0] as readonly Pt[];
    const uk = footprint("UK").polys[0] as readonly Pt[];
    expect(footprint("DE").hub).toEqual(centroid(de));
    expect(footprint("UK").hub).toEqual(centroid(uk));
    expect(pip(footprint("UK").hub![0], footprint("UK").hub![1], uk)).toBe(true);
    expect(pip(footprint("DE").hub![0], footprint("DE").hub![1], de)).toBe(true);
  });
});

describe("centroid", () => {
  test("is the mean of the anchors", () => {
    const triangle: Pt[] = [[0, 0], [30, 0], [0, 30]];
    expect(centroid(triangle)).toEqual([10, 10]);
  });
});

describe("dotMatrix", () => {
  const TRIANGLE: Pt[] = [[0, 0], [30, 0], [0, 30]];

  test("drops a dot on exactly the grid points the polygon covers", () => {
    // The 15 px grid from 10 hits this triangle once, at (10, 10); (10, 25) and
    // (25, 10) fall outside the hypotenuse.
    expect(dotMatrix([TRIANGLE])).toEqual([{ x: 10, y: 10, delay: 0 }]);
  });

  test("delays each dot by its distance from the hub, and a hubless matrix by nothing", () => {
    const withHub = dotMatrix([TRIANGLE], [0, 0]);
    expect(withHub[0]?.delay).toBeCloseTo(Math.hypot(10, 10) * 0.0016, 12);
    expect(withHub[0]?.delay).not.toBe(0);
  });

  test("covers land across a real footprint's extent, on the 15 px grid", () => {
    const eu = REGION_FOOTPRINTS.find((f) => f.value === "EU") as Footprint;
    const dots = dotMatrix(eu.polys, eu.hub);
    expect(dots.length).toBeGreaterThan(0);
    // EUR reaches west to x≈456 — dots stand on it, on the grid, each delayed by
    // its distance from the EMEA hub (EU has one; only GLOBAL is hubless).
    const xs = dots.map((d) => d.x);
    expect(Math.min(...xs)).toBeLessThanOrEqual(460);
    for (const dot of dots) {
      expect((dot.x - 10) % DOT_STEP).toBe(0);
      expect((dot.y - 10) % DOT_STEP).toBe(0);
      expect(dot.delay).toBeGreaterThan(0);
    }
    // GLOBAL is the whole map: hundreds of dots, hubless like EU's.
    const global = REGION_FOOTPRINTS.find((f) => f.value === "GLOBAL") as Footprint;
    expect(dotMatrix(global.polys).length).toBeGreaterThan(200);
  });
});

describe("the graticule", () => {
  test("sits on the mockup's 960×500 grid, verticals every 120, horizontals every 100", () => {
    expect(MAP_WIDTH).toBe(960);
    expect(MAP_HEIGHT).toBe(500);
    expect(GRATICULE_VERTICALS).toEqual([120, 240, 360, 480, 600, 720, 840]);
    expect(GRATICULE_HORIZONTALS).toEqual([100, 200, 300, 400]);
  });
});
