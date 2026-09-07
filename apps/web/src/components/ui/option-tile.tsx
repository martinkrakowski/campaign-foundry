import { useId, type ReactNode } from "react";
import { cn } from "../../lib/cn";

export interface OptionTileProps {
  /** The raw option value — it is also the button's accessible name, verbatim. */
  readonly value: string;
  readonly selected: boolean;
  readonly onToggle: (value: string) => void;
  /**
   * The picture, sized by the caller — a slot, not a well. Rendered aria-hidden
   * by the tile; unselected it dims (a transition, never a loop — D88).
   */
  readonly children: ReactNode;
  /** The visible name under the picture; the accessible name stays `value`. */
  readonly name: string;
  /** A small classification pill beside the name; decorative. */
  readonly tag?: string;
  /** Neutral body copy under the name (`text-text-secondary`). Not the gate's reason. */
  readonly blurb?: string;
  /** The muted caption line (e.g. a count); decorative. */
  readonly meta?: string;
  /**
   * Why this option is unavailable, or anything else assistive technology must
   * hear. Exposed via `aria-describedby`, which — unlike content — never joins
   * the accessible name, so the name stays exactly `value`. Warning-toned, like
   * `AxisCard`'s: a gate's reason is never neutral prose.
   */
  readonly description?: string;
  readonly disabled?: boolean;
}

/**
 * The richer sibling of `AxisCard` (D87): a picture, a name, a tag, a blurb and a
 * meta line instead of a fixed 44px well and one caption. The picture is a
 * caller-sized slot — the fixed well is why `PlatformCard` can only ever show a
 * `RatioFrame` — and every word is a prop; no literals, no `messages` import.
 *
 * The accessible-name contract is `AxisCard`'s, copied not reinvented: the name
 * is exactly `value` (an explicit aria-label, which overrides content), and the
 * picture, tag, blurb, meta line and check badge are all aria-hidden so none of
 * them can concatenate into it. `blurb` and `description` are two different
 * slots and must not be merged — see the prop docs.
 */
export function OptionTile({
  value,
  selected,
  onToggle,
  children,
  name,
  tag,
  blurb,
  meta,
  description,
  disabled = false,
}: OptionTileProps): ReactNode {
  const descriptionId = `option-tile-description-${useId()}`;
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
        // A control's own edge is `border-border-control`, not `border-border`
        // (DESIGN.md §2, WCAG 1.4.11): `border-border` frames, controls bound.
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
          "block transition-[opacity,filter]",
          // The mockup's dim: unselected previews sit back and return to full on
          // selection — a transition on an interaction, never a loop (D88).
          selected ? "opacity-100 saturate-100" : "opacity-[0.55] saturate-[0.45]",
        )}
      >
        {children}
      </span>
      <span className="flex w-full items-baseline justify-between gap-2">
        <span className="text-[15px] font-bold leading-tight text-text-primary">{name}</span>
        {tag ? (
          <span
            aria-hidden="true"
            className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-text-muted"
          >
            {tag}
          </span>
        ) : null}
      </span>
      {blurb ? (
        <span aria-hidden="true" className="text-[12px] leading-snug text-text-secondary">
          {blurb}
        </span>
      ) : null}
      {meta ? (
        <span aria-hidden="true" className="text-[11px] leading-snug text-text-muted">
          {meta}
        </span>
      ) : null}
      {description === undefined ? null : (
        <span id={descriptionId} className="text-[11px] leading-snug text-warning">
          {description}
        </span>
      )}
    </button>
  );
}
