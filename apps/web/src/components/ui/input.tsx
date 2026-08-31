import type { InputHTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Render in an error state (red border + aria-invalid). */
  invalid?: boolean;
}

/**
 * Text input stub. Token-driven border and focus halo; sets aria-invalid so
 * forms and screen readers stay in sync with the visual error state.
 *
 * The halo is a 25% brand ring rather than the solid ring `Button` uses: an input
 * holds the caret, so the focus already has a second carrier and a solid ring at
 * this size crowds the field. It is a `focus:` state, not `focus-visible:`, because
 * a text field the user has clicked into is focused in the only way that matters —
 * there is no keyboard-only case to distinguish. An invalid field keeps the error
 * border and takes no brand border: the reason it is red outranks the reason it is
 * focused.
 */
export function Input(props: InputProps): ReactNode {
  const { className, invalid = false, ...rest } = props;
  return (
    <input
      className={cn(
        "h-10 w-full rounded-md border bg-background px-3 text-sm text-text-primary",
        "placeholder:text-text-muted",
        "focus:outline-none focus:ring-2 focus:ring-brand-primary/25",
        "disabled:cursor-not-allowed disabled:opacity-50",
        invalid ? "border-error" : "border-border-control focus:border-brand-primary",
        className,
      )}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
}
