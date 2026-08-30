import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export interface SwitchRowProps {
  /** The row's label — both the visible text and the switch's accessible name. */
  readonly label: string;
  readonly checked: boolean;
  readonly onToggle: () => void;
  /** Gating blocks entering a state, never leaving one — off must stay clickable. */
  readonly disabled?: boolean;
  /** The state line under the label (checking / N approved / none approved + a link). */
  readonly children?: ReactNode;
}

/**
 * A labelled boolean with room for a status line — for optional axes that read as a
 * sentence ("Vary the headline too · 2 approved headlines"), not as a bare chip.
 * The switch is a real `role="switch"` button: `aria-checked` carries the state and
 * the knob is `aria-hidden` decoration, so the name stays exactly the label.
 */
export function SwitchRow({ label, checked, onToggle, disabled = false, children }: SwitchRowProps): ReactNode {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <span className={cn("block text-[13px]", checked ? "text-text-emphasis" : "text-text-primary")}>{label}</span>
        {children ? <span className="mt-0.5 block text-[11px] text-text-muted">{children}</span> : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={onToggle}
        className={cn(
          "relative flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-2",
          "disabled:cursor-not-allowed disabled:opacity-50",
          checked ? "border-brand-primary bg-brand-primary" : "border-border bg-surface-2",
        )}
      >
        {/* The knob is the inverse of the rail, not a fixed white: off, the rail is
            `surface-2`, which is near-white in the light theme, and a white knob on it
            has no edge. `text-emphasis` reads on both rails in both themes. */}
        <span
          aria-hidden="true"
          className={cn(
            "absolute size-3.5 rounded-full bg-text-emphasis transition-[left]",
            checked ? "left-[1.1875rem]" : "left-0.5",
          )}
        />
      </button>
    </div>
  );
}
