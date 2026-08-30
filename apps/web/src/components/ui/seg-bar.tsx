"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import * as messages from "@/components/campaign/messages";

export interface SegBarSegment {
  /** The step this segment stands for — one entry per step, in step order. */
  readonly id: string;
  /** The step's name, from the one vocabulary the whole editor reads. */
  readonly label: string;
  /** How many things on this step still need fixing. Zero reads as done. */
  readonly issues: number;
}

export interface SegBarProps {
  /** One segment per step: the editor's derived list, never a copy of it. */
  readonly segments: readonly SegBarSegment[];
  /** The step being shown. */
  readonly index: number;
  /** The furthest step reached. Read for styling; never a gate (D21). */
  readonly maxVisited: number;
  /** Show a step. Every segment is live, however far past it the walk has got. */
  readonly onSelect: (index: number) => void;
}

/**
 * The fill of one segment, per state. The brand blue is the walk's *progress* — how
 * far it has got — not a verdict on the step: the only state colour in the row is the
 * red of a step with something to fix (DESIGN.md §2).
 */
const BAR_TONES: Record<messages.SegBarState, string> = {
  current: "bg-brand-primary",
  done: "bg-brand-primary/40",
  issues: "bg-error",
  unvisited: "bg-border",
};

/**
 * Where a segment stands (WIZ-10). `maxVisited` is what separates "done" from
 * "not started" — and it is the *only* thing it does: a segment past it is styled
 * as unvisited and stays as reachable as any other (D21). The mock locked those
 * segments while its own sidebar rows walked straight past the lock.
 */
function segmentState(
  position: number,
  index: number,
  maxVisited: number,
  issues: number,
): messages.SegBarState {
  if (position === index) return "current";
  if (position > maxVisited) return "unvisited";
  return issues > 0 ? "issues" : "done";
}

/**
 * W7.1 — the step walk as one row of segments (WIZ-09). It knows nothing about
 * sections, modes or validation: the caller hands it the steps it already derived
 * for the cursor (D19) and how many things each still needs, and every segment is
 * a live control, because a step is not gated on the one before it validating
 * (D3). The four states are painted, and the current one also carries
 * `aria-current="step"` — the mock's sweeping fill loop (WIZ-12) carried no
 * information a static tint does not, and a loop is never the only carrier of
 * meaning (DESIGN.md §2).
 */
export function SegBar({ segments, index, maxVisited, onSelect }: SegBarProps): ReactNode {
  return (
    <nav aria-label={messages.segBarLabel}>
      <ol className="flex items-stretch gap-1.5">
        {segments.map((segment, position) => {
          const state = segmentState(position, index, maxVisited, segment.issues);
          return (
            <li key={segment.id} className="flex-1">
              <button
                type="button"
                aria-current={state === "current" ? "step" : undefined}
                aria-label={messages.segBarSegment(position + 1, segments.length, segment.label, state)}
                onClick={() => onSelect(position)}
                className="group block w-full py-2.5"
              >
                <span
                  className={cn(
                    "block h-1.5 w-full rounded-full",
                    BAR_TONES[state],
                    // The mock's hover growth (WIZ-11). A transform is motion, so it
                    // is gated: a visitor who asked for less of it gets a bar that
                    // simply changes colour.
                    "motion-safe:transition-transform motion-safe:duration-fast",
                    "motion-safe:group-hover:scale-y-[1.4]",
                  )}
                />
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
