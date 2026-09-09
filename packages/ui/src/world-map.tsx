import { useMemo, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { cn } from "./cn";
import { polyPath, type Pt } from "./geo/chaikin";
import { dotMatrix, GRATICULE_HORIZONTALS, GRATICULE_VERTICALS, MAP_HEIGHT, MAP_WIDTH, type Footprint, type MapDot } from "./geo/footprints";
import { pip } from "./geo/pip";

export interface WorldMapProps {
  /** The footprints to paint, in vocabulary order (§2.3). */
  readonly footprints: readonly Footprint[];
  /** The selected value, or `null` for no selection (e.g. a free-text region). */
  readonly value: string | null;
  /** Called with a footprint's value when its landmass is clicked. */
  readonly onSelect: (value: string) => void;
  /** Hub text and hover caption. The kit owns geometry, not copy. */
  readonly labelFor: (value: string) => string;
  /**
   * Visually-hidden hint rendered beside the map. The SVG is `aria-hidden` — a pointer
   * enhancement bound to the same state as the chips (D94), which remain the sole
   * accessible and keyboard control.
   */
  readonly fallbackHint: string;
  readonly className?: string;
}

/** Shoelace area of one polygon; `Math.abs` so a clockwise or counter-clockwise winding never matters. */
export function polygonArea(pts: readonly Pt[]): number {
  let sum = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    sum += xj * yi - xi * yj;
  }
  return Math.abs(sum) / 2;
}

/** A footprint's summed polygon area — its "size" for hit-testing, computed once per footprints prop. */
export function footprintArea(footprint: Footprint): number {
  return footprint.polys.reduce((total, poly) => total + polygonArea(poly), 0);
}

export interface Painted extends Footprint {
  readonly dots: readonly MapDot[];
  readonly area: number;
}

/**
 * The footprint under a point: every footprint whose polygons contain it, the one
 * with the smallest summed area winning — the most specific region under the cursor.
 * An exact tie goes to the footprint declared later: `painted` iterates in
 * declaration order and `<=` replaces on equality, so the later footprint replaces
 * the earlier. The rule is arbitrary, but a written-down decision — a silent tie
 * would flip with iteration order and read as a heisenbug.
 */
export function footprintAt(x: number, y: number, painted: readonly Painted[]): Painted | undefined {
  let hit: Painted | undefined;
  for (const f of painted) {
    if (!f.polys.some((poly) => pip(x, y, poly))) continue;
    if (hit === undefined || f.area <= hit.area) hit = f;
  }
  return hit;
}

/**
 * The world map: one `<g>` per footprint with its dot matrix, in token colours.
 * Single-select (D94) — no `multiple`, no arcs; the hub ripple is refused (D96),
 * the dot reveal is a one-shot transition on selection, which D96 permits.
 * Hit-testing is geometric — `footprintAt` on the clicked point — never paint
 * order, so clicking a selected region again re-selects it instead of passing
 * through to the region containing it (the GLOBAL / EU trap).
 */
export function WorldMap({
  footprints,
  value,
  onSelect,
  labelFor,
  fallbackHint,
  className,
}: WorldMapProps): ReactNode {
  const [hovered, setHovered] = useState<string | null>(null);
  const caption = hovered === null ? "" : labelFor(hovered);

  // The dot matrix and the footprint areas are generated geometry — compute them
  // once per footprints prop, not on every hover or click re-render.
  const painted = useMemo<Painted[]>(
    () => footprints.map((f) => ({ ...f, dots: dotMatrix(f.polys, f.hub), area: footprintArea(f) })),
    [footprints],
  );
  // Unselected stay in vocabulary order; the selected footprint paints last so an
  // overlapping later region cannot cover it. Unknown / null values paint as-is.
  const selectedFootprint = painted.find((f) => f.value === value);
  const ordered = selectedFootprint === undefined
    ? painted
    : [...painted.filter((f) => f.value !== selectedFootprint.value), selectedFootprint];

  // The one true pointer handler. A click's point is resolved geometrically —
  // the smallest containing footprint wins — regardless of which element is on
  // top or whether anything is selected, so paint order never decides a hit.
  const handleSvgClick = (event: ReactMouseEvent<SVGSVGElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * MAP_WIDTH;
    const y = ((event.clientY - rect.top) / rect.height) * MAP_HEIGHT;
    const hit = footprintAt(x, y, painted);
    if (hit !== undefined) onSelect(hit.value);
  };

  return (
    <div className={cn("space-y-1", className)}>
      <svg
        viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
        aria-hidden="true"
        focusable="false"
        className="w-full"
        onClick={handleSvgClick}
        onMouseLeave={() => setHovered(null)}
      >
        {/* The graticule: the mockup's hairline lat/long grid. */}
        <g className="stroke-text-muted/[0.08]" strokeWidth={1}>
          {GRATICULE_VERTICALS.map((x) => (
            <line key={`v-${x}`} x1={x} y1={0} x2={x} y2={MAP_HEIGHT} />
          ))}
          {GRATICULE_HORIZONTALS.map((y) => (
            <line key={`h-${y}`} x1={0} y1={y} x2={MAP_WIDTH} y2={y} />
          ))}
        </g>

        <g>
          {ordered.map((f) => {
            const selected = value === f.value;
            return (
              <g
                key={f.value}
                data-region={f.value}
                data-selected={selected || undefined}
                className="group cursor-pointer"
                onMouseEnter={() => setHovered(f.value)}
              >
                {f.polys.map((poly, i) => (
                  <path
                    key={i}
                    d={polyPath(poly)}
                    strokeWidth={1}
                    className={cn(
                      "transition-colors",
                      selected
                        ? "fill-brand-primary/20 stroke-brand-primary/55"
                        : "fill-text-muted/[0.16] stroke-border group-hover:stroke-border-hover",
                    )}
                  />
                ))}
                {f.dots.map((dot) => (
                  <circle
                    key={`${dot.x}-${dot.y}`}
                    cx={dot.x}
                    cy={dot.y}
                    r={1.5}
                    pointerEvents="none"
                    style={{ transformBox: "fill-box", transformOrigin: "center", transitionDelay: `${dot.delay}s` }}
                    className={cn(
                      "fill-brand-primary/90 motion-safe:transition-transform motion-safe:duration-fast",
                      selected ? "scale-100" : "scale-0",
                    )}
                  />
                ))}
                {selected && f.hub !== undefined ? (
                  <circle cx={f.hub[0]} cy={f.hub[1]} r={2.5} className="fill-brand-primary" />
                ) : null}
                {selected ? (
                  <text
                    x={f.hub !== undefined ? f.hub[0] + 6 : MAP_WIDTH / 2}
                    y={f.hub !== undefined ? f.hub[1] - 6 : MAP_HEIGHT / 2}
                    textAnchor={f.hub !== undefined ? undefined : "middle"}
                    className="fill-text-primary font-mono text-[11px]"
                  >
                    {labelFor(f.value)}
                  </text>
                ) : null}
              </g>
            );
          })}
        </g>
      </svg>
      {/* The hover caption: mono, under the map, empty until a footprint is hovered. */}
      <p className="font-mono text-[11px] text-text-muted">{caption}</p>
      <p className="sr-only">{fallbackHint}</p>
    </div>
  );
}
