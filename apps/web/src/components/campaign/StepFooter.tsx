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
  /**
   * Bump to replay the one-shot ready ring. The editor counts the transitions of
   * the step it is showing into "nothing left to fix" (W7.4) and passes the count
   * here; the key is what turns that count into a replay.
   */
  readyKey: number;
}

/**
 * W6.5 — the step footer: the step status sentence and the Back/Next pair.
 * Next is never `disabled` (D3): a refused Next sets the attempted flag, reveals
 * that step's errors, replays the one-shot nudge, and leaves the step where it
 * was — the button stays live so pressing it again is how the user re-asks.
 *
 * W7.4 gives it the other half of that conversation: the moment the step has
 * nothing left to fix, Next wears a single ring. It is one-shot and it is fired by
 * a *count* the editor keeps of the step's transitions into complete — never by a
 * boolean read on every render, which would re-fire it on every keystroke. The
 * mock's `readyPulse` ran forever; a loop on a control is a control that never
 * stops asking for attention (D27).
 *
 * Both animations are one-shots named in `globals.css`, and both are listed in its
 * reduced-motion block rather than killed by a blanket rule: a wildcard
 * `animation: none` freezes `animate-spin` mid-ring while `Button` has already
 * swapped its label for the spinner.
 */
export function StepFooter({ statusText, onBack, onNext, nextLabel, nudgeKey, readyKey }: StepFooterProps) {
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
          <span
            // Keyed on the ring, so a step becoming complete replays it. The button
            // inside is remounted with it; the focus this costs is the focus a
            // visitor has just spent typing into a field, not the press that asked
            // for the refusal — that one stays put, one span deeper.
            key={readyKey}
            className={cn("inline-flex rounded-md", readyKey > 0 && "animate-ready-ring")}
          >
            <Button type="button" onClick={onNext}>
              <span
                key={nudgeKey}
                className={cn("inline-flex items-center gap-2", nudgeKey > 0 && "animate-nudge")}
              >
                {nextLabel ?? messages.stepNext}
              </span>
            </Button>
          </span>
        ) : null}
      </div>
      {/* The swipe hint (W7.3 / WIZ-30): a finger is the only pointer that can
          swipe, so the sentence is painted for coarse pointers and not at all for a
          mouse — where a promise of "swipe" would be a lie. */}
      <p className="mt-2 hidden text-[11px] text-text-muted [@media(pointer:coarse)]:block">
        {messages.stepSwipeHint}
      </p>
    </footer>
  );
}
