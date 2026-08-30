"use client";

import { Button } from "@/components/ui";
import { cn } from "@/lib/cn";
import * as messages from "./messages";

interface StepFooterProps {
  /** The step's status sentence — read out when the step changes (W6.5). */
  statusText: string;
  /** Back to the previous step. Absent on the first step, never disabled (D3). */
  onBack?: () => void;
  /** Advance past this step. Absent on the review step. Never disabled (D3). */
  onNext?: () => void;
  /** Overrides the Next label — the editor uses "Review & launch" before Review. */
  nextLabel?: string;
  /**
   * Bump to replay the one-shot refusal nudge. The key lives on the label span
   * inside the button, so a remount replays the animation without the button
   * node (and the focus the user pressed) being replaced (W6.5).
   */
  nudgeKey: number;
}

/**
 * W6.5 — the step footer: the step status sentence and the Back/Next pair.
 * Next is never `disabled` (D3): a refused Next sets the attempted flag, reveals
 * that step's errors, replays the one-shot nudge, and leaves the step where it
 * was — the button stays live so pressing it again is how the user re-asks.
 *
 * The refusal nudge is a scoped keyframe rather than a class in `globals.css`:
 * W7.4 owns the shared `nudge` there, and this one-shot must survive without it.
 * Reduced motion keeps the sentence but plays no shake.
 */
export function StepFooter({ statusText, onBack, onNext, nextLabel, nudgeKey }: StepFooterProps) {
  return (
    <footer className="mt-6 border-t border-border pt-4">
      <p role="status" className="text-[13px] text-text-primary">
        {statusText}
      </p>
      <div className="mt-3 flex items-center justify-between gap-3">
        {onBack ? (
          <Button type="button" variant="ghost" onClick={onBack}>
            {messages.stepBack}
          </Button>
        ) : null}
        {onNext ? (
          <Button type="button" onClick={onNext}>
            <span
              key={nudgeKey}
              className={cn("inline-flex items-center gap-2", nudgeKey > 0 && "kf-step-nudge")}
            >
              {nextLabel ?? messages.stepNext}
            </span>
          </Button>
        ) : null}
      </div>

    </footer>
  );
}