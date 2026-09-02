import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export interface SliderProps {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  /**
   * The granule the track moves in, default 1 (the bounded integer the slider
   * was). Fractional values serve bounds that are themselves fractional — the
   * Style VO's type metrics (T7) — without re-scaling the stored value.
   */
  step?: number;
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
}

/**
 * Bounded range input. A range is the right control when the bound is the point —
 * the user is choosing within a budget (how many creatives, how different they must
 * be) rather than typing an exact figure, and the track shows how much room is left.
 * The readout keeps the number legible, since a range alone shows only a position.
 */
export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  disabled = false,
  invalid = false,
  suffix,
  readout,
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
          step={step}
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
    </div>
  );
}
