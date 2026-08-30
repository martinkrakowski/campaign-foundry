import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> {
  /**
   * The accessible name. Required rather than optional: an icon-only control has no
   * text to name it, so an omitted label is not a smaller button but a nameless one
   * — invisible to `getByLabelText` and to anything reading the page aloud.
   */
  readonly label: string;
}

/**
 * A 32px square control holding one icon (W2a.1 / SHELL-11).
 *
 * `grid place-items-center` centres the glyph box without the inline-baseline gap a
 * flex row reserves beneath an inline SVG — the reason each bespoke close and copy
 * button this replaces needed its own nudge. `flex-none` because these live in rows
 * that run short of space (a drawer header, the header's right cluster) and a square
 * that shrinks is the first thing a flex parent squeezes.
 *
 * Resting colour is muted, hover lifts to `text-text-emphasis`, so the icon carries
 * `currentColor` and inherits both. There is deliberately no `focus-visible` ring
 * here: W2a.3 adds one global rule, so a control that forgets to style focus still
 * has a ring — and every control gets the same one.
 */
export function IconButton({ label, className, type = "button", ...rest }: IconButtonProps): ReactNode {
  return (
    <button
      type={type}
      aria-label={label}
      className={cn(
        "grid size-8 flex-none place-items-center rounded-sm text-text-muted transition-colors hover:text-text-emphasis",
        className,
      )}
      {...rest}
    />
  );
}
