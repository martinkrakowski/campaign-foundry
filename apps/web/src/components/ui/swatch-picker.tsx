import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Input } from "./input";

/** The 8 canonical product swatches available in the brand palette. */
export const SWATCH_PALETTE = [
  "#1473E6",
  "#E0218A",
  "#FF7A00",
  "#10B981",
  "#8B5CF6",
  "#F59E0B",
  "#EF4444",
  "#06B6D4",
] as const;

export interface SwatchPickerProps {
  /** The currently selected hex colour string. */
  readonly value: string;
  /** Callback when a swatch is selected or custom hex typed. */
  readonly onChange: (hex: string) => void;
  /** Optional custom palette of swatches (defaults to SWATCH_PALETTE). */
  readonly swatches?: readonly string[];
  readonly label?: string;
  readonly invalid?: boolean;
  readonly disabled?: boolean;
  readonly readOnly?: boolean;
}

/**
 * An 8-swatch colour selector paired with a mono hex readout (D12 / L3.4).
 *
 * Each preset button has an accessible name equal to its hex value (`aria-label={hex}`).
 * The hex input allows custom hex entries and reflects the current selection.
 */
export function SwatchPicker({
  value,
  onChange,
  swatches = SWATCH_PALETTE,
  label,
  invalid = false,
  disabled = false,
  readOnly = false,
}: SwatchPickerProps): ReactNode {
  const normalizedValue = value.trim().toUpperCase();

  return (
    <div
      role="group"
      aria-label={label ? `${label} options` : undefined}
      className="flex flex-wrap items-center gap-3"
    >
      <div className="flex items-center gap-1.5">
        {swatches.map((hex) => {
          const isSelected = normalizedValue === hex.toUpperCase();
          return (
            <button
              key={hex}
              type="button"
              aria-label={hex}
              aria-pressed={isSelected}
              disabled={disabled || readOnly}
              onClick={() => onChange(hex)}
              className={cn(
                "relative size-6 rounded-full border transition-all",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-2",
                "disabled:cursor-not-allowed disabled:opacity-50",
                isSelected
                  ? "ring-2 ring-brand-primary ring-offset-2 ring-offset-background scale-110 border-white/40"
                  : "border-border hover:scale-105 hover:border-border-hover",
              )}
              style={{ backgroundColor: hex }}
            >
              {isSelected ? (
                <span className="flex items-center justify-center text-white drop-shadow-sm" aria-hidden="true">
                  <svg viewBox="0 0 12 12" focusable="false" className="size-3">
                    <path
                      d="M2 6.5 5 9.5 10 3"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="w-28">
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="#1473E6"
          aria-label={label ?? "Hex colour"}
          className="font-mono text-[12px]"
          invalid={invalid}
          disabled={disabled}
          readOnly={readOnly}
        />
      </div>
    </div>
  );
}
