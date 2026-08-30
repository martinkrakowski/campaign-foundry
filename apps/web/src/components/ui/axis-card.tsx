import { useId, type ReactNode } from "react";
import { cn } from "../../lib/cn";

export interface AxisCardProps {
  /** The raw option value — it is also the button's accessible name, verbatim. */
  readonly value: string;
  readonly selected: boolean;
  readonly onToggle: (value: string) => void;
  /** The preview (e.g. a CreativeGlyph); rendered aria-hidden by the card. */
  readonly children: ReactNode;
  /** Optional caption under the value; aria-hidden so it cannot extend the name. */
  readonly meta?: string;
  /**
   * What the card *shows*, when that differs from what it *is*. The accessible name stays
   * `value` either way: assistive tech and the YAML agree on the raw term, while the screen
   * can read "Video" instead of "motion" (D18). Defaults to `value`.
   */
  readonly label?: string;
  /**
   * Why this option is unavailable, or anything else assistive technology must
   * hear. Exposed via `aria-describedby`, which — unlike content — never joins
   * the accessible name, so the name stays exactly `value`.
   */
  readonly description?: string;
  readonly descriptionIcon?: ReactNode;
  readonly disabled?: boolean;
}

/**
 * The selectable card for one value of a fixed-vocabulary axis (D28 / D29 / W2b.1).
 * It adopts the mock's .opt idiom: 1.5px border, a 44px preview tile that inverts
 * when pressed, a 22px overshoot check badge, a 15px/700 label, and motion-safe hover/press.
 *
 * The accessible name is exactly `value` (an explicit aria-label, which
 * overrides content): tests across the app query these controls as
 * getByRole("button", { name: "headline-top" }), and any extra text inside the
 * button would concatenate into the name and break them. The preview, the check
 * badge and the meta line are all aria-hidden for that reason.
 */
export function AxisCard({
  value,
  selected,
  onToggle,
  children,
  meta,
  label,
  description,
  descriptionIcon,
  disabled = false,
}: AxisCardProps): ReactNode {
  const descriptionId = `axis-card-description-${useId()}`;
  return (
    <button
      type="button"
      aria-label={value}
      aria-pressed={selected}
      {...(description === undefined ? {} : { "aria-describedby": descriptionId })}
      disabled={disabled}
      onClick={() => onToggle(value)}
      className={cn(
        "relative flex flex-col items-start gap-2 rounded-md border-[1.5px] p-3.5 text-left transition-all",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-2",
        "motion-safe:hover:-translate-y-px motion-safe:active:scale-[0.97]",
        "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:active:scale-100",
        selected
          ? "border-brand-primary bg-brand-primary/[0.08]"
          : "border-border-control bg-surface-2 hover:border-border-control-hover",
      )}
    >
      {selected ? (
        <span
          className="absolute right-2.5 top-2.5 flex size-[22px] items-center justify-center rounded-full bg-brand-primary text-white motion-safe:animate-check-pop"
          aria-hidden="true"
        >
          <svg viewBox="0 0 12 12" focusable="false" aria-hidden="true" className="size-3 text-white">
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
      <span
        aria-hidden="true"
        className={cn(
          "flex size-11 shrink-0 items-center justify-center rounded-md transition-colors",
          selected ? "bg-brand-primary text-white" : "bg-background text-text-secondary",
        )}
      >
        {children}
      </span>
      <span className={cn("text-[15px] font-bold leading-tight", selected ? "text-text-emphasis" : "text-text-primary")}>
        {label ?? value}
      </span>
      {meta ? (
        <span aria-hidden="true" className="text-[12px] text-text-muted leading-snug">
          {meta}
        </span>
      ) : null}
      {description === undefined ? null : (
        <span id={descriptionId} className="flex items-center gap-1 text-[11px] text-warning">
          {descriptionIcon ? <span aria-hidden="true">{descriptionIcon}</span> : null}
          <span>{description}</span>
        </span>
      )}
    </button>
  );
}
