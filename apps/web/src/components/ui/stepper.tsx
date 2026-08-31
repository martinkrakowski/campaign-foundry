import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export interface StepperProps {
  /** The value as the editor stores it: a whole number, or "" for unset. */
  value: string;
  min: number;
  max: number;
  onChange: (value: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  "aria-label": string;
  /**
   * Allow an unset value, shown as "Auto". Stepping below `min` returns to it. These
   * fields are genuinely optional — the planner has its own default — and a plain
   * number input cannot express "I have not chosen" without an empty box that reads
   * as a mistake.
   */
  allowUnset?: boolean;
  /** What "unset" means here, e.g. "Auto (1)". */
  unsetLabel?: string;
}

/**
 * Small bounded integer. A stepper suits a value with a handful of sensible
 * settings: it states the bounds by disabling its own buttons, and cannot accept
 * the malformed input a free-text number field invites.
 */
export function Stepper({
  value,
  min,
  max,
  onChange,
  disabled = false,
  invalid = false,
  allowUnset = false,
  unsetLabel = "Auto",
  "aria-label": ariaLabel,
}: StepperProps): ReactNode {
  const unset = value.trim() === "";
  const current = unset ? min : Number(value);
  const numeric = Number.isFinite(current) ? current : min;
  const atFloor = unset || numeric <= min;
  const atCeiling = !unset && numeric >= max;

  const step = (delta: number): void => {
    if (unset) {
      onChange(String(min));
      return;
    }
    const next = numeric + delta;
    if (next < min) {
      onChange(allowUnset ? "" : String(min));
      return;
    }
    onChange(String(Math.min(next, max)));
  };

  const button = (label: string, symbol: string, delta: number, atLimit: boolean) => (
    <button
      type="button"
      aria-label={`${label} ${ariaLabel}`}
      disabled={disabled || atLimit}
      onClick={() => step(delta)}
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border-control text-text-primary transition-colors",
        "hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40",
      )}
    >
      {symbol}
    </button>
  );

  return (
    <div className="flex items-center gap-2">
      {button("Decrease", "−", -1, allowUnset ? unset : atFloor)}
      {/* spinbutton, not <output>: this is a value, not a live result. <output> carries an
          implicit role="status", which would make every stepper a live region. */}
      <div
        role="spinbutton"
        tabIndex={-1}
        aria-label={ariaLabel}
        aria-valuenow={unset ? undefined : numeric}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuetext={unset ? unsetLabel : undefined}
        className={cn(
          "min-w-[4.5rem] rounded-md border px-2 py-1 text-center font-mono text-[12px] tabular-nums",
          invalid ? "border-error text-error" : "border-border-control",
          unset ? "text-text-muted" : "text-text-primary",
        )}
      >
        {unset ? unsetLabel : value}
      </div>
      {button("Increase", "+", 1, atCeiling)}
    </div>
  );
}
