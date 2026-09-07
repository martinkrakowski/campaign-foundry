import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export interface PreviewPanelProps {
  /** The picture — e.g. a `PosterFrame` or a `PosterStack` — centred on the panel. */
  readonly children: ReactNode;
  /** The mono readout in the panel's bottom-right corner (e.g. a count); decorative. */
  readonly caption?: string;
  /**
   * The unselected treatment (`opacity-[0.55] saturate-[0.45]`). Standalone use
   * only: when the panel sits in an `OptionTile`'s `preview` slot, the tile dims
   * its own wrapper — leave this unset there.
   */
  readonly dimmed?: boolean;
  /** The panel's fixed height in px. */
  readonly height?: number;
}

/**
 * The mockup's `.pvbox`: a full-width panel on its own `bg-background` ground
 * with a rule beneath, rounded at the top only — the preview sits edge to edge
 * inside the card, above the padded body, not as a picture in a frame (D93).
 * The dim/undim is a transition on an interaction, never a loop (D88).
 */
export function PreviewPanel({
  children,
  caption,
  dimmed = false,
  height = 132,
}: PreviewPanelProps): ReactNode {
  return (
    <div
      className={cn(
        "relative flex w-full items-center justify-center overflow-hidden rounded-t-md border-b border-border bg-background",
        "transition-[opacity,filter]",
        dimmed ? "opacity-[0.55] saturate-[0.45]" : "opacity-100 saturate-100",
      )}
      style={{ height }}
    >
      {children}
      {caption === undefined ? null : (
        <span
          aria-hidden="true"
          className="absolute bottom-1.5 right-2 font-mono text-[10px] text-text-muted"
        >
          {caption}
        </span>
      )}
    </div>
  );
}
