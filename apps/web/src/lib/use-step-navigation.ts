"use client";

import { useCallback, useMemo, useState } from "react";

export interface StepNavigation {
  /** The step being shown, 0-based, always inside the list. */
  index: number;
  /** Which way the user got here: 1 forward, -1 back. */
  direction: 1 | -1;
  /** The furthest step reached so far. Read by the UI, never a gate. */
  maxVisited: number;
  /** Move to a step, clamped into the list. */
  go: (step: number) => void;
}

/**
 * W6.1 — the guided editor's step cursor. It owns the two things the section list
 * does not: where the user is, and which way they came (a Next slide goes forward,
 * a Back goes back). The list itself is derived, never stored (D19): give it the
 * steps for the current mode, and when the mode flips the list changes shape under
 * the cursor — the index re-clamps into it rather than stranding the user past the
 * last section.
 *
 * `maxVisited` is deliberately advisory. It exists for styling a step a visitor has
 * already reached; gating anything on it would reintroduce the locked-step editor
 * guided mode exists to remove (D21). The Next refusal is the sections' own
 * voice, decided in the editor, not here.
 */
export function useStepNavigation(steps: readonly string[]): StepNavigation {
  // A list that is never empty keeps the clamp sane; the editor's is never empty
  // (both modes produce five sections plus the review step), so this is a guard,
  // not a branch the editor can reach.
  const upper = Math.max(0, steps.length - 1);
  const clamp = useMemo(() => (n: number) => Math.max(0, Math.min(upper, n)), [upper]);

  // The raw values may outlive a list change (mode flips replace the list under the
  // cursor); everything the UI consumes is the clamped view, so a step that is no
  // longer there cannot be reached or marked visited.
  const [rawIndex, setRawIndex] = useState(0);
  const [rawMaxVisited, setRawMaxVisited] = useState(0);
  const [direction, setDirection] = useState<1 | -1>(1);

  const index = clamp(rawIndex);

  const go = useCallback(
    (requested: number) => {
      const next = clamp(requested);
      // Asking for a step outside the list walks to the nearest one in it — the
      // outline's rows ask for the same thing, and the guided variant of them needs
      // the same answer.
      setRawIndex(next);
      setRawMaxVisited((visited) => Math.max(visited, next));
      setDirection(next > index ? 1 : -1);
    },
    [clamp, index],
  );

  return { index, direction, maxVisited: clamp(rawMaxVisited), go };
}