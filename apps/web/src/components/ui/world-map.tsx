import { useMemo, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { polyPath } from "./geo/chaikin";
import { dotMatrix, GRATICULE_HORIZONTALS, GRATICULE_VERTICALS, MAP_HEIGHT, MAP_WIDTH, type Footprint } from "./geo/footprints";

export interface WorldMapProps {
  /** The footprints to paint, in vocabulary order (§2.3). */
  readonly footprints: readonly Footprint[];
  /** The selected value, or `null` for no selection (e.g. a free-text region). */
  readonly value: string | null;
  /** Called with a footprint's value when its landmass is clicked. */
  readonly onSelect: (value: string) => void;
  /** The hover caption's text; defaults to the footprint's label. */
  readonly hoverLabel?: (value: string) => string;
  /**
   * Visually-hidden hint rendered beside the map. The SVG is `aria-hidden` — a pointer
   * enhancement bound to the same state as the chips (D94), which remain the sole
   * accessible and keyboard control.
   */
  readonly fallbackHint: string;
  readonly className?: string;
}

/**
 * The world map: one `<g>` per footprint with its dot matrix, in token colours.
 * Single-select (D94) — no `multiple`, no arcs; the hub ripple is refused (D96),
 * the dot reveal is a one-shot transition on selection, which D96 permits.
 */
export function WorldMap({
  footprints,
  value,
  onSelect,
  hoverLabel,
  fallbackHint,
  className,
}: WorldMapProps): ReactNode {
  const [hovered, setHovered] = useState<{ readonly value: string; readonly label: string } | null>(null);
  const caption = hovered === null
    ? ""
    : hoverLabel !== undefined
      ? hoverLabel(hovered.value)
      : hovered.label;

  // The dot matrix is generated geometry — compute it once per footprints prop, not
  // on every hover re-render.
  const painted = useMemo(
    () => footprints.map((f) => ({ ...f, dots: dotMatrix(f.polys, f.hub) })),
    [footprints],
  );

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

        {painted.map((f) => {
          const selected = value === f.value;
          return (
            <g
              key={f.value}
              data-region={f.value}
              data-selected={selected || undefined}
              className="group cursor-pointer"
              onClick={() => onSelect(f.value)}
              onMouseEnter={() => setHovered({ value: f.value, label: f.label })}
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
                  style={{ transformBox: "fill-box", transformOrigin: "center", transitionDelay: `${dot.delay}s` }}
                  className={cn(
                    "fill-brand-primary/90 transition-transform duration-fast",
                    selected ? "scale-100" : "scale-0",
                  )}
                />
              ))}
              {f.hub !== undefined ? (
                <circle cx={f.hub[0]} cy={f.hub[1]} r={2.5} className={selected ? "fill-brand-primary" : "fill-text-muted"} />
              ) : null}
              {selected ? (
                <text
                  x={f.hub !== undefined ? f.hub[0] + 6 : MAP_WIDTH / 2}
                  y={f.hub !== undefined ? f.hub[1] - 6 : MAP_HEIGHT / 2}
                  textAnchor={f.hub !== undefined ? undefined : "middle"}
                  className="fill-text-primary font-mono text-[11px]"
                >
                  {f.label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      {/* The hover caption: mono, under the map, empty until a footprint is hovered. */}
      <p className="font-mono text-[11px] text-text-muted">{caption}</p>
      <p className="sr-only">{fallbackHint}</p>
    </div>
  );
}
