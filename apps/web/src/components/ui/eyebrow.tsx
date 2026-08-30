import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** The tags an eyebrow may be: it is a label, so it is either inline or a heading. */
export type EyebrowTag = "span" | "p" | "h2" | "h3" | "h4";

export interface EyebrowProps {
  readonly children?: ReactNode;
  readonly as?: EyebrowTag;
  readonly className?: string;
}

/**
 * The mono-uppercase group label (W2a.5 / DESIGN.md §2): a drawer's list heading, a
 * strip's caption, a status badge's family. It carries the one type pattern the mock
 * uses everywhere the repo wrote it out longhand — `font-mono text-[11px] uppercase
 * tracking-widest text-text-muted` — so the family cannot drift apart one site at a
 * time.
 *
 * The tag is a prop because the same words are a heading in one place (`Assets (3)`
 * titles a list, and belongs in the outline) and an inline caption beside a control
 * in another; the text does not decide that, the surrounding outline does.
 *
 * `tracking-eyebrow` (0.08em) is a token rather than Tailwind's `tracking-widest`
 * for the same reason every colour here is a token: the value is stated once, in
 * `tailwind.config.ts`, and retuning it moves all fourteen sites together.
 */
export function Eyebrow({ as: Tag = "span", className, children }: EyebrowProps): ReactNode {
  return (
    <Tag className={cn("font-mono text-[11px] uppercase tracking-eyebrow text-text-muted", className)}>
      {children}
    </Tag>
  );
}
