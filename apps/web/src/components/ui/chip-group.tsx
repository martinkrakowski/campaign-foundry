import { useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Input } from "./input";

export interface ChipGroupProps {
  /** The accessible group label. */
  readonly label?: string;
  /** The list of selectable standard options. */
  readonly options: readonly string[];
  /** The currently selected value (or custom value). */
  readonly value: string;
  /** Callback when a chip is clicked or custom input changes. */
  readonly onChange: (value: string) => void;
  /** Whether to render the 'Other…' escape chip that reveals custom text input. */
  readonly allowOther?: boolean;
  /** Label for the other chip (defaults to "Other…"). */
  readonly otherLabel?: string;
  /** Placeholder for the custom text input. */
  readonly otherPlaceholder?: string;
  readonly invalid?: boolean;
  readonly disabled?: boolean;
  readonly readOnly?: boolean;
}

/**
 * A labelled set of single-select chips with an *Other…* escape that reveals a
 * free-text input (D18 / L3.2).
 *
 * Accessible name of every option chip is its raw value verbatim (same a11y
 * contract as AxisCard and SwatchChip). The Other button reveals a text input for
 * arbitrary entries outside the fixed set.
 */
export function ChipGroup({
  label,
  options,
  value,
  onChange,
  allowOther = false,
  otherLabel = "Other…",
  otherPlaceholder = "e.g. LATAM",
  invalid = false,
  disabled = false,
  readOnly = false,
}: ChipGroupProps): ReactNode {
  const isCustomValue = value !== "" && !options.includes(value);
  const [customOpen, setCustomOpen] = useState(false);
  const showCustomInput = allowOther && (customOpen || isCustomValue);

  const handleOptionClick = (option: string) => {
    setCustomOpen(false);
    onChange(option);
  };

  const handleOtherClick = () => {
    setCustomOpen(true);
    if (options.includes(value)) {
      onChange("");
    }
  };

  return (
    <div role="group" aria-label={label ? `${label} options` : undefined} className="space-y-2">
      <input
        type="text"
        aria-label={label ?? "Target Region"}
        className="sr-only"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        tabIndex={-1}
      />
      <div className="flex flex-wrap items-center gap-1.5">
        {options.map((option) => {
          const selected = value === option && !customOpen;
          return (
            <button
              key={option}
              type="button"
              aria-label={option}
              aria-pressed={selected}
              disabled={disabled || readOnly}
              onClick={() => handleOptionClick(option)}
              className={cn(
                "flex items-center justify-center rounded-md border px-3 py-1.5 font-mono text-[12px] transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-2",
                "disabled:cursor-not-allowed disabled:opacity-50",
                selected
                  ? "border-brand-primary bg-surface-2 text-white"
                  : "border-border bg-background text-text-muted hover:border-border-hover",
              )}
            >
              {option}
            </button>
          );
        })}
        {allowOther ? (
          <button
            type="button"
            aria-label={otherLabel}
            aria-pressed={showCustomInput}
            disabled={disabled || readOnly}
            onClick={handleOtherClick}
            className={cn(
              "flex items-center justify-center rounded-md border px-3 py-1.5 font-mono text-[12px] transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-2",
              "disabled:cursor-not-allowed disabled:opacity-50",
              showCustomInput
                ? "border-brand-primary bg-surface-2 text-white"
                : "border-border bg-background text-text-muted hover:border-border-hover",
            )}
          >
            {otherLabel}
          </button>
        ) : null}
      </div>

      {showCustomInput ? (
        <div className="pt-1">
          <Input
            value={options.includes(value) ? "" : value}
            placeholder={otherPlaceholder}
            onChange={(e) => onChange(e.target.value)}
            invalid={invalid}
            disabled={disabled}
            readOnly={readOnly}
            autoFocus
          />
        </div>
      ) : null}
    </div>
  );
}
