import { useRef, type ReactNode } from "react";
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
  /** Size of swatches: "default" (24px) or "lg" (52px for step cards). */
  readonly size?: "default" | "lg";
}

function isValidHex(hex: string): boolean {
  return /^#[0-9A-Fa-f]{6}$/.test(hex.trim());
}

/**
 * An 8-swatch colour selector + 9th custom colour swatch paired with a mono hex readout (D12 / L3.4 / W2b.3).
 *
 * Each preset button has an accessible name equal to its hex value (`aria-label={hex}`).
 * The 9th custom swatch triggers a labelled visually-hidden `<input type="color">`.
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
  size = "default",
}: SwatchPickerProps): ReactNode {
  const normalizedValue = value.trim().toUpperCase();
  const isPaletteMatch = swatches.some((hex) => hex.toUpperCase() === normalizedValue);
  const isCustomSelected = !isPaletteMatch && normalizedValue.length > 0;
  const colorInputRef = useRef<HTMLInputElement>(null);
  const isLg = size === "lg";

  const sizeClasses = isLg ? "size-[52px]" : "size-6";
  const ringClasses = isLg
    ? "ring-[3px] ring-brand-primary ring-offset-2 ring-offset-background scale-105"
    : "ring-2 ring-brand-primary ring-offset-2 ring-offset-background scale-110";

  return (
    <div
      role="group"
      aria-label={label ? `${label} options` : undefined}
      className="flex flex-wrap items-center gap-3"
    >
      <div className="flex flex-wrap items-center gap-2">
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
                "relative rounded-full border border-border-control transition-all",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-2",
                "disabled:cursor-not-allowed disabled:opacity-50",
                sizeClasses,
                isSelected
                  ? ringClasses
                  : "hover:scale-105 hover:border-border-control-hover",
              )}
              style={{ backgroundColor: hex }}
            >
              {isSelected ? (
                <span className="flex items-center justify-center text-white drop-shadow-sm" aria-hidden="true">
                  <svg viewBox="0 0 12 12" focusable="false" className={isLg ? "size-5" : "size-3"}>
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

        {/* 9th Custom Swatch */}
        <button
          type="button"
          aria-label={label ? `${label} custom colour` : "Custom colour"}
          aria-pressed={isCustomSelected}
          disabled={disabled || readOnly}
          onClick={() => colorInputRef.current?.click()}
          className={cn(
            "relative flex items-center justify-center rounded-full border border-dashed transition-all",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-2",
            "disabled:cursor-not-allowed disabled:opacity-50",
            sizeClasses,
            isCustomSelected
              ? cn(ringClasses, "border-brand-primary")
              : "border-border-control bg-surface-2 text-text-muted hover:border-brand-primary hover:text-brand-primary",
          )}
          style={isCustomSelected && isValidHex(value) ? { backgroundColor: value } : undefined}
        >
          {isCustomSelected ? (
            <span className="flex items-center justify-center text-white drop-shadow-sm" aria-hidden="true">
              <svg viewBox="0 0 12 12" focusable="false" className={isLg ? "size-5" : "size-3"}>
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
          ) : (
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={isLg ? "size-5" : "size-3.5"}
              aria-hidden="true"
            >
              <path d="M10 2l4 4-9 9H1v-4l9-9z" />
              <path d="M8.5 3.5l4 4" />
            </svg>
          )}
        </button>

        <input
          ref={colorInputRef}
          type="color"
          aria-label={label ? `${label} custom colour picker` : "Custom colour picker"}
          value={isValidHex(value) ? value : "#1473E6"}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          className="sr-only"
          disabled={disabled || readOnly}
          tabIndex={-1}
        />
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
