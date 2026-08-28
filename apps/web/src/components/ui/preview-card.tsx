import { useId, type ReactNode } from "react";
import { cn } from "../../lib/cn";

export interface PreviewCardProps {
  /** The raw option value — it is also the button's accessible name, verbatim. */
  readonly value: string;
  readonly selected: boolean;
  readonly onToggle: (value: string) => void;
  /** The preview (e.g. what each background source paints); rendered aria-hidden. */
  readonly children: ReactNode;
  /** The human caption under the preview, e.g. "Pattern"; aria-hidden. */
  readonly meta: string;
  /**
   * Anything assistive technology must hear. Exposed via `aria-describedby`, which —
   * unlike content — never joins the accessible name, so the name stays `value`.
   */
  readonly description?: string;
  readonly disabled?: boolean;
}

/**
 * The horizontal sibling of `AxisCard`, for options whose preview is a picture of
 * what you get rather than a miniature of the creative (the background sources).
 * Same a11y contract as the kit's cards: the accessible name is exactly the raw
 * value (an explicit aria-label), so the preview, the caption and the check mark
 * are all `aria-hidden` decoration.
 */
export function PreviewCard({
  value,
  selected,
  onToggle,
  children,
  meta,
  description,
  disabled = false,
}: PreviewCardProps): ReactNode {
  const descriptionId = `preview-card-description-${useId()}`;
  return (
    <button
      type="button"
      aria-label={value}
      aria-pressed={selected}
      {...(description === undefined ? {} : { "aria-describedby": descriptionId })}
      disabled={disabled}
      onClick={() => onToggle(value)}
      className={cn(
        "relative flex w-full items-center gap-3 rounded-md border p-3 text-left transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-2",
        "disabled:cursor-not-allowed disabled:opacity-50",
        selected ? "border-brand-primary bg-surface-2" : "border-border hover:border-border-hover",
      )}
    >
      {selected ? (
        <span className="absolute right-1.5 top-1.5" aria-hidden="true">
          <svg viewBox="0 0 12 12" focusable="false" aria-hidden="true" className="size-3 text-brand-primary">
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
      <span aria-hidden="true" className="flex shrink-0 items-center justify-center">
        {children}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("block text-[13px]", selected ? "text-white" : "text-text-primary")}>{meta}</span>
        <span className={cn("block font-mono text-[12px]", selected ? "text-white" : "text-text-muted")} aria-hidden="true">
          {value}
        </span>
      </span>
      {description === undefined ? null : (
        <span id={descriptionId} className="text-[11px] text-warning">
          {description}
        </span>
      )}
    </button>
  );
}
