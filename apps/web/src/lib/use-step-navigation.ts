"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type TouchEvent } from "react";

/**
 * One `--duration-normal` (tokens.css), in milliseconds: how long the editor holds
 * the step card that is on its way out. The animation it waits for reads the same
 * token in `globals.css`, so the hold and the transition it is holding for cannot
 * drift apart.
 */
export const STEP_TRANSITION_MS = 250;

/** How far a finger must travel before the gesture is a swipe and not a tap (WIZ-26). */
const SWIPE_MIN_PX = 60;
/** How much more sideways than vertical that travel has to be. */
const SWIPE_AXIS_RATIO = 1.4;

/** The places a keystroke lands *inside* something that types. */
const TYPING_SELECTOR = "input, textarea, select, [contenteditable='true'], [role='textbox']";
/**
 * Any modal in the app. Dialogs and drawers both carry the pair, and both unmount
 * when they close — so one in the DOM is one on screen, and there is no open/closed
 * bookkeeping for this to drift out of step with.
 */
const OVERLAY_SELECTOR = '[role="dialog"][aria-modal="true"]';

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

  // The cursor remembers *which step* it is on, not just where it sat. A mode flip
  // replaces the list under it, and the two lists disagree at the same ordinal —
  // classic is [.., treatments, output], randomized [.., output, policy] — so a
  // purely positional cursor silently moves the user from Output to Variation Policy
  // on a flip. Following the id keeps them where they were; the remembered ordinal is
  // the fallback for the one step a flip really does remove (`treatments`).
  // `steps[0]` is asserted, not guarded: the same non-empty contract the clamp above
  // relies on. A guard here would be an unreachable branch, and the house rule is to
  // restructure one away rather than exclude it from coverage.
  const [cursor, setCursor] = useState<{ id: string; index: number }>(() => ({
    id: steps[0] as string,
    index: 0,
  }));
  const byId = steps.indexOf(cursor.id);
  const [rawMaxVisited, setRawMaxVisited] = useState(0);
  const [direction, setDirection] = useState<1 | -1>(1);

  const index = byId === -1 ? clamp(cursor.index) : byId;

  const go = useCallback(
    (requested: number) => {
      const next = clamp(requested);
      // Asking for a step outside the list walks to the nearest one in it — the
      // outline's rows ask for the same thing, and the guided variant of them needs
      // the same answer.
      setCursor({ id: steps[next] as string, index: next });
      setRawMaxVisited((visited) => Math.max(visited, next));
      setDirection(next > index ? 1 : -1);
    },
    [clamp, index, steps],
  );

  return { index, direction, maxVisited: clamp(rawMaxVisited), go };
}

/* ── The step gestures (W7.3) ─────────────────────────────────────────────── */

/**
 * Whether a key or a finger landed inside something that types (W7.3). A left arrow
 * in a text field moves the caret; a horizontal drag across a slider is the slider.
 * Neither is the step walk's to answer, and answering them is how a wizard eats the
 * keystroke the user aimed at their own words.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  // A keydown aimed at the window or the document was not aimed at a field at all.
  if (!(target instanceof Element)) return false;
  return target.closest(TYPING_SELECTOR) !== null;
}

const GESTURE_SELECTOR = '[role="slider"], input[type="range"], [draggable="true"]';

/**
 * Whether a target owns its own gesture (e.g. a slider or a draggable element).
 * A horizontal drag across a slider is the slider, not a step swipe.
 */
export function ownsItsOwnGesture(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(GESTURE_SELECTOR) !== null;
}

/** Whether a modal is on screen — in which case the arrow keys belong to it (W7.3). */
export function overlayIsOpen(): boolean {
  return document.querySelector(OVERLAY_SELECTOR) !== null;
}

/**
 * What a travel asks for: 1 forward, -1 back, 0 = not a swipe (WIZ-26). Sixty pixels
 * is the floor, and the travel must be at least 1.4× more sideways than vertical —
 * a scroll down the column drifts horizontally, and must not turn the page.
 */
export function swipeDirection(dx: number, dy: number): -1 | 0 | 1 {
  if (Math.abs(dx) < SWIPE_MIN_PX) return 0;
  if (Math.abs(dx) < Math.abs(dy) * SWIPE_AXIS_RATIO) return 0;
  // Dragging left pulls the next step in, the way a page turn does.
  return dx < 0 ? 1 : -1;
}

export interface StepSwipeHandlers {
  readonly onTouchStart: (event: TouchEvent<HTMLElement>) => void;
  readonly onTouchEnd: (event: TouchEvent<HTMLElement>) => void;
}

/**
 * W7.3 — swipe between steps. The gesture is only ever the *start's*: a drag that
 * begins on a slider is the slider's for its whole length, however far it wanders.
 * Callers spread the pair onto the step card and call `go` with the result, which
 * clamps — so a swipe past either end of the walk does nothing at all.
 */
export function useStepSwipe(onSwipe: (direction: -1 | 1) => void): StepSwipeHandlers {
  // Held in a ref so the handlers keep one identity for the life of the card: the
  // caller passes a fresh arrow on every render, and a listener re-bound on each
  // keystroke elsewhere would be re-bound here too.
  const swipe = useRef(onSwipe);
  swipe.current = onSwipe;
  const origin = useRef<{ x: number; y: number; typing: boolean; ownsGesture: boolean } | null>(null);

  const onTouchStart = useCallback((event: TouchEvent<HTMLElement>) => {
    const touch = event.changedTouches[0];
    origin.current = {
      x: touch.clientX,
      y: touch.clientY,
      typing: isTypingTarget(event.target),
      ownsGesture: ownsItsOwnGesture(event.target),
    };
  }, []);

  const onTouchEnd = useCallback((event: TouchEvent<HTMLElement>) => {
    const start = origin.current;
    origin.current = null;
    // No start means no gesture: a `touchend` that arrives on its own is not half a
    // swipe, and a spent start cannot be spent twice.
    if (start === null || start.typing || start.ownsGesture || overlayIsOpen()) return;
    const touch = event.changedTouches[0];
    const direction = swipeDirection(touch.clientX - start.x, touch.clientY - start.y);
    if (direction === 0) return;
    swipe.current(direction);
  }, []);

  return { onTouchStart, onTouchEnd };
}

export interface UseStepKeysOptions {
  /** Off outside the guided walk: the stacked editor has no step to move. */
  readonly enabled: boolean;
  /** Move a step: 1 forward, -1 back. The caller's `go` clamps at both ends. */
  readonly onStep: (direction: -1 | 1) => void;
}

/**
 * W7.3 — Arrow Left / Arrow Right move between steps (WIZ-27), suppressed inside a
 * field and while an overlay is open. Two things are deliberately not intercepted:
 * a chord (Cmd+Left is the browser's own Back, not ours), and any other key, so the
 * walk never eats a keystroke it does not own.
 */
export function useStepKeys({ enabled, onStep }: UseStepKeysOptions): void {
  const step = useRef(onStep);
  step.current = onStep;

  useEffect(() => {
    if (!enabled) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (isTypingTarget(event.target) || ownsItsOwnGesture(event.target) || overlayIsOpen()) return;
      // The step walk is the only thing that wanted this key, so it is spent here
      // and nothing else downstream sees an arrow it may also have a use for.
      event.preventDefault();
      step.current(event.key === "ArrowRight" ? 1 : -1);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled]);
}

/**
 * W7.4 — how many times `watched` has *become* true within one `subject`, and zero
 * for any subject that has not. The transition is the whole point: a ring that
 * fires on every render of a step that is already complete re-fires on every
 * keystroke, which is the mock's infinite pulse in a cheaper disguise.
 *
 * The subject is what keeps "became" honest, and it rebases the count: a step
 * announces that it became complete while the visitor was standing on it, not that
 * it was already complete when they arrived. So walking onto a finished step reads
 * zero — and the caller, reading a zero, wears no ring at all.
 */
export function useBecameTrue(watched: boolean, subject: unknown): number {
  const [state, setState] = useState<{ subject: unknown; value: boolean; count: number } | null>(null);

  useEffect(() => {
    setState((before) => {
      // A first pass, or a new subject: nothing has become anything here yet.
      if (before === null || before.subject !== subject) return { subject, value: watched, count: 0 };
      const became = before.value === false && watched;
      return { subject, value: watched, count: before.count + (became ? 1 : 0) };
    });
  }, [watched, subject]);

  return state !== null && state.subject === subject ? state.count : 0;
}
