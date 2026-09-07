import type { Pt } from "./chaikin";
import { pip } from "./pip";
import {
  AFR, ARA, ASIA, AUS, BOR, DE, EUR, GRL, HUB_APAC, HUB_EMEA, HUB_NA,
  IRL, J1, J2, JAV, LAT, NA, NG, NZN, NZS, PHI, SCAN, SLK, SUL, SUM, TAS, TWN,
  UK, US,
} from "./polygons";

// The vocabulary of §2.3 (plan 2026-09-07_graphics-and-the-world-map, D94), mapped to
// footprints in REGION_OPTIONS order. The kit owns geometry, not copy — the consumer
// supplies labels via WorldMap's `labelFor`. `Other…` has no footprint and is absent.

/** The map's fixed grid, ported from the mockup's 960×500 viewBox. */
export const MAP_WIDTH = 960;
export const MAP_HEIGHT = 500;

export interface Footprint {
  readonly value: string;
  readonly polys: readonly (readonly Pt[])[];
  /** The hub dot's anchor; `GLOBAL` has none — its label sits at the map's centre. */
  readonly hub?: Pt;
}

/** The mockup's landmass polygons — everything `GLOBAL` paints. */
const LANDMASSES: readonly (readonly Pt[])[] = [
  NA, GRL, LAT, EUR, SCAN, UK, IRL, AFR, ARA, ASIA,
  J1, J2, TWN, PHI, SUM, JAV, BOR, SUL, NG, SLK, AUS, TAS, NZN, NZS,
];

/** Mean of the anchor points — the hub for a polygon the mockup gave no hub. */
export function centroid(pts: readonly Pt[]): Pt {
  const x = pts.reduce((sum, p) => sum + p[0], 0) / pts.length;
  const y = pts.reduce((sum, p) => sum + p[1], 0) / pts.length;
  return [x, y];
}

export const REGION_FOOTPRINTS: readonly Footprint[] = [
  { value: "GLOBAL", polys: LANDMASSES },
  { value: "EU", polys: [EUR, SCAN], hub: HUB_EMEA },
  { value: "DE", polys: [DE], hub: centroid(DE) },
  { value: "UK", polys: [UK], hub: centroid(UK) },
  { value: "US", polys: [US], hub: HUB_NA },
  {
    value: "APAC",
    polys: [ASIA, J1, J2, TWN, PHI, SUM, JAV, BOR, SUL, NG, SLK, AUS, TAS, NZN, NZS],
    hub: HUB_APAC,
  },
];

// The dot matrix, ported from the mockup's trailing rules: a 15 px grid over the
// map, a dot wherever `pip` holds for any polygon of the footprint, and each dot's
// reveal delayed by its distance from the hub (D96: a transition on selection, not
// a loop). `GLOBAL` has no hub, so its dots reveal together.
const DOT_START = 10;
const DOT_MAX_X = 955;
const DOT_MAX_Y = 492;
export const DOT_STEP = 15;
const DOT_DELAY_PER_PX = 0.0016;

export interface MapDot {
  readonly x: number;
  readonly y: number;
  /** Seconds; the dot's `transition-delay` from its hub (0 when there is no hub). */
  readonly delay: number;
}

export function dotMatrix(polys: readonly (readonly Pt[])[], hub?: Pt): MapDot[] {
  const dots: MapDot[] = [];
  for (let x = DOT_START; x <= DOT_MAX_X; x += DOT_STEP) {
    for (let y = DOT_START; y <= DOT_MAX_Y; y += DOT_STEP) {
      let onLand = false;
      for (const poly of polys) {
        if (pip(x, y, poly)) {
          onLand = true;
          break;
        }
      }
      if (onLand) {
        dots.push({
          x,
          y,
          delay: hub === undefined ? 0 : Math.hypot(x - hub[0], y - hub[1]) * DOT_DELAY_PER_PX,
        });
      }
    }
  }
  return dots;
}

// The graticule, ported from the mockup's trailing rules: verticals every 120 from
// 120..<900, horizontals every 100 from 100..<500.
function graticuleLines(start: number, step: number, max: number): number[] {
  const lines: number[] = [];
  for (let v = start; v < max; v += step) {
    lines.push(v);
  }
  return lines;
}

export const GRATICULE_VERTICALS: readonly number[] = graticuleLines(120, 120, 900);
export const GRATICULE_HORIZONTALS: readonly number[] = graticuleLines(100, 100, 500);
