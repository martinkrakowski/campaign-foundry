import { useMemo, useState, type ReactNode } from "react";
import { cn } from "./cn";
import { polyPath, type Pt } from "./geo/chaikin";
import { dotMatrix, GRATICULE_HORIZONTALS, GRATICULE_VERTICALS, MAP_HEIGHT, MAP_WIDTH, type Footprint, type MapDot } from "./geo/footprints";

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
 * The world map: one `<g>` per footprint with its dot matrix, in token colours.
 * Single-select (D94) — no `multiple`, no arcs; the hub ripple is refused (D96),
 * the dot reveal is a one-shot transition on selection, which D96 permits.
 * Footprints are sorted by descending area so the smallest paints last (topmost).
 * Each group carries its own `onClick`, so paint order = hit order, and a click
 * reaches the smallest footprint under the cursor without coordinate arithmetic.
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
  // Descending area: the smallest footprint paints last and is therefore topmost.
  // Paint order = hit order, so a click on a group element selects that footprint
  // without coordinate arithmetic.
  const ordered = useMemo(() => [...painted].sort((a, b) => b.area - a.area), [painted]);

  return (
    <div className={cn("space-y-1", className)}>
      <svg
        viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
        aria-hidden="true"
        focusable="false"
        className="w-full"
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
                onClick={() => onSelect(f.value)}
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
