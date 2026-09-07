import type { ReactNode } from "react";

const TICKS = [0.33, 0.66] as const;
const HEAD = 0.3;

/**
 * A rounded track with two tick marks and a `brand-primary` head parked at
 * ~30 % — the static replacement for the mockup's sweeping playhead (§2.2).
 * The head does not move: nothing here animates, ever (D88). Wholly decorative
 * (`aria-hidden`); the option's name carries the meaning.
 */
export function ScrubBar(): ReactNode {
  return (
    <span aria-hidden="true" className="relative block h-1.5 w-full rounded-full bg-text-muted/18">
      {TICKS.map((tick) => (
        <span
          key={tick}
          className="absolute top-[-3px] h-3 w-px bg-text-secondary/30"
          style={{ left: `${tick * 100}%` }}
        />
      ))}
      <span
        className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand-primary"
        style={{ left: `${HEAD * 100}%` }}
      />
    </span>
  );
}
