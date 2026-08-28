import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export interface SliderProps {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  invalid?: boolean;
  "aria-label": string;
  /** Rendered after the value in the readout, e.g. "s". */
  suffix?: string;
  /**
   * Replaces the default "value / max" readout — a sentence, when words carry the
   * bound better than the bare numbers do (the count slider's "12 ads · up to 24…").
   */
  readout?: ReactNode;
  /**
   * Word ticks under the track, spread evenly (a little · some · very). Decorative:
   * aria-hidden, because the numbers on the track remain the truth.
   */
  ticks?: readonly string[];
}

/**
 * Bounded integer input. A range is the right control when the bound is the point —
 * the user is choosing within a budget (how many creatives, how different they must
 * be) rather than typing an exact figure, and the track shows how much room is left.
 * The readout keeps the number legible, since a range alone shows only a position.
 */
export function Slider({
  value,
  min,
  max,
  onChange,
  disabled = false,
  invalid = false,
  suffix,
  readout,
  ticks,
  "aria-label": ariaLabel,
}: SliderProps): ReactNode {
  const safeMax = Math.max(min, max);
  const clamped = Math.min(Math.max(value, min), safeMax);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-3">
        <input
          type="range"
          aria-label={ariaLabel}
          min={min}
          max={safeMax}
          step={1}
          value={clamped}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          onChange={(e) => onChange(Number(e.target.value))}
          className={cn(
            "h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-surface-2 accent-brand-primary",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        />
        {readout ?? (
          <span
            className={cn(
              "shrink-0 rounded-md border px-2 py-0.5 font-mono text-[12px] tabular-nums",
              invalid ? "border-error text-error" : "border-border text-text-primary",
            )}
          >
            {clamped}
            {suffix}
            <span className="text-text-muted">
              {" / "}
              {safeMax}
            </span>
          </span>
        )}
      </div>
      {ticks ? (
        <div className="flex justify-between px-1" aria-hidden="true">
          {ticks.map((tick) => (
            <span key={tick} className="text-[10px] text-text-muted">
              {tick}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
