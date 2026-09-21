import { useId, type ReactNode } from "react";
import { cn } from "./cn";

export interface OptionTileProps {
  /** The raw option value — it is also the button's accessible name, verbatim. */
  readonly value: string;
  readonly selected: boolean;
  readonly onToggle: (value: string) => void;
  /**
   * The picture, sized by the caller — a slot, not a well. Rendered aria-hidden
   * by the tile; unselected it dims (a transition, never a loop — D88). For a
   * caller that wants a glyph, not a panel — a full-bleed panel goes in
   * `preview` below.
   */
  readonly children: ReactNode;
  /**
   * A full-bleed preview panel rendered edge to edge above the body, outside
   * the padding — the mockup's `.pvbox` (F3). The tile applies the unselected
   * dim to its own wrapper around this node. Leave `dimmed` unset inside a
   * tile slot: a nested `PreviewPanel` that also sets `dimmed` double-dims.
   */
  readonly preview?: ReactNode;
  /** The visible name under the picture; the accessible name stays `value`. */
  readonly name: string;
  /** A small classification pill beside the name; decorative. */
  readonly tag?: string;
  /** Neutral body copy under the name (`text-text-secondary`). Not the gate's reason. */
  readonly blurb?: string;
  /** The muted caption line (e.g. a count); decorative. */
  readonly meta?: string;
  /**
   * Why this option is unavailable. Exposed via `aria-describedby`, which —
   * unlike content — never joins the accessible name, so the name stays exactly
   * `value`. Rendered **visibly**, warning-toned, like `AxisCard`'s: a gate's
   * reason is never neutral prose.
   *
   * It is not the slot for "anything else assistive technology must hear" —
   * that is `srDescription` below. Text that is not a refusal, put here, is
   * painted in the refusal colour on a tile where nothing is wrong.
   */
  readonly description?: string;
  /**
   * What assistive technology must hear that the screen already shows — a
   * mirror, not a refusal. Rendered `sr-only` and joined into the same
   * `aria-describedby`, after `description`'s id when both are set, so the
   * announcement order is the DOM order is the visual order.
   *
   * It exists because the tile aria-hides every decorative slot (`children`,
   * `preview`, `tag`, `blurb`, `meta`) and pins the accessible name to `value`:
   * a caller whose facts live in those slots has no other way to reach the
   * accessibility tree. `description` is not that way — it is the gate's
   * reason, and it is painted in the refusal colour.
   *
   * `AxisCard`, `PlatformCard` and `PreviewCard` share this tile's name
   * contract but deliberately not this slot: no caller of theirs puts
   * substantive facts into an aria-hidden slot today, and an unused prop is
   * surface without a defect behind it. Give them the same slot when one does.
   */
  readonly srDescription?: string;
  readonly disabled?: boolean;
}

/**
 * The richer sibling of `AxisCard` (D87): a picture, a name, a tag, a blurb and a
 * meta line instead of a fixed 44px well and one caption. The picture is a
 * caller-sized slot — the fixed well is why `PlatformCard` can only ever show a
 * `RatioFrame` — and every word is a prop; no literals, no `messages` import.
 *
 * An optional `preview` panel runs edge to edge above the body (F3): the
 * padding lives on the body wrapper, not the button, so the panel touches the
 * tile's own edges like the mockup's `.pvbox`. Leave `dimmed` unset inside a
 * tile slot — this wrapper is the one dim.
 *
 * The accessible-name contract is `AxisCard`'s, copied not reinvented: the name
 * is exactly `value` (an explicit aria-label, which overrides content), and the
 * picture, preview, tag, blurb, meta line and check badge are all aria-hidden
 * so none of them can concatenate into it. `blurb` and `description` are two
 * different slots and must not be merged — see the prop docs.
 */
export function OptionTile({
  value,
  selected,
  onToggle,
  children,
  preview,
  name,
  tag,
  blurb,
  meta,
  description,
  srDescription,
  disabled = false,
}: OptionTileProps): ReactNode {
  const id = useId();
  const descriptionId = `option-tile-description-${id}`;
  const srDescriptionId = `option-tile-sr-description-${id}`;
  // One slot still yields one bare id, not a one-element join: every caller of
  // `aria-describedby` in this repo's tests and in the platform resolves it with
  // `getElementById`, and a join is only correct when there really are two.
  const describedBy = [
    description === undefined ? null : descriptionId,
    srDescription === undefined ? null : srDescriptionId,
  ]
    .filter((candidate) => candidate !== null)
    .join(" ");
  const dim = selected ? "opacity-100 saturate-100" : "opacity-[0.55] saturate-[0.45]";
  return (
    <button
      type="button"
      aria-label={value}
      aria-pressed={selected}
      {...(describedBy === "" ? {} : { "aria-describedby": describedBy })}
      disabled={disabled}
      onClick={() => onToggle(value)}
      className={cn(
        // The padding is on the body wrapper, not here: the preview panel runs
        // edge to edge above the body (F3).
        "relative flex flex-col items-stretch rounded-md border-[1.5px] text-left transition-all",
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
          className="absolute right-2.5 top-2.5 flex size-[22px] items-center justify-center rounded-full bg-brand-primary text-brand-on-primary motion-safe:animate-check-pop"
          aria-hidden="true"
        >
          <svg
            viewBox="0 0 12 12"
            focusable="false"
            aria-hidden="true"
            className="size-3 text-brand-on-primary"
          >
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
      {preview === undefined ? null : (
        <span aria-hidden="true" className={cn("block transition-[opacity,filter]", dim)}>
          {preview}
        </span>
      )}
      <span className="flex flex-col items-start gap-2 p-3.5">
        <span aria-hidden="true" className={cn("block transition-[opacity,filter]", dim)}>
          {children}
        </span>
        <span className="flex w-full min-w-0 items-baseline justify-between gap-2">
          {/* A name is user data (a brief id may be 64 unbroken chars). Truncate
              it; `title` is the hover remainder. The button's aria-label still
              owns the accessible name, so the tooltip cannot join it. */}
          <span
            className="min-w-0 truncate text-sm font-bold leading-tight text-text-primary"
            title={name}
          >
            {name}
          </span>
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
        {srDescription === undefined ? null : (
          // `sr-only` is absolutely positioned, so it joins no flex row and
          // costs the tile no gap — the house idiom (chip-group.tsx:97,
          // swatch-picker.tsx:171, world-map.tsx:166).
          <span id={srDescriptionId} className="sr-only">
            {srDescription}
          </span>
        )}
      </span>
    </button>
  );
}
