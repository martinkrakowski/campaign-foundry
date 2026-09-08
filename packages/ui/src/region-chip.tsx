import type { ReactNode } from "react";
import { cn } from "./cn";

export interface RegionChipProps {
  /** The accessible name — exactly the label, nothing else. */
  readonly label: string;
  /** The mono value code shown beside the label. */
  readonly code: string;
  readonly pressed: boolean;
  readonly onToggle: () => void;
  readonly disabled?: boolean;
}

/**
 * The mockup's region chip with a state dot: the dot fills the brand token when
 * pressed. The accessible name is exactly `label` (the kit's card contract) — the
 * dot and the mono code are `aria-hidden`, so they never join the name.
 */
export function RegionChip({ label, code, pressed, onToggle, disabled = false }: RegionChipProps): ReactNode {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-2",
        "disabled:cursor-not-allowed disabled:opacity-50",
        pressed
          ? "border-brand-primary bg-surface-2 text-text-emphasis"
          : "border-border-control bg-background text-text-muted hover:border-border-control-hover",
      )}
    >
      <span
        aria-hidden="true"
        className={cn("size-1.5 rounded-full", pressed ? "bg-brand-primary" : "border border-border-control")}
      />
      <span>{label}</span>
      <span aria-hidden="true" className="font-mono text-[10px] text-text-muted">
        {code}
      </span>
    </button>
  );
}
