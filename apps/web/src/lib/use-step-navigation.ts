"use client";

/**
 * SG1 — what is left of the wizard's navigation module.
 *
 * This file owned the six-step walk: the step cursor (`useStepNavigation`), the
 * arrow-key and swipe gestures, `useBecameTrue` for the Next button's ready ring,
 * and `STEP_TRANSITION_MS` for the step-card transition. SG-D2 retired the wizard,
 * so all of that is deleted rather than kept as code no surface can reach.
 *
 * Two things survive because they have live callers that are not the walk:
 *
 * - `isTypingTarget` — read by `editor-history.ts`'s undo chord (VE1), which asks
 *   the same question for the same reason: a ⌘Z inside a text field belongs to the
 *   field's own undo, not to the editor's.
 * - the step baton (`stashStep`/`takeStashedStep`) — still written by
 *   `CreateCampaignDialog` and still spent by `create-campaign.ts`'s `takeSeed`.
 *   Its APPLIER was the step cursor, so nothing reads it to any effect any more;
 *   retiring the write and the spend belongs to whoever owns the create flow, and
 *   until then the pair stays so the key cannot be left behind unspent.
 */

/** The places a keystroke lands *inside* something that types. */
const TYPING_SELECTOR = "input, textarea, select, [contenteditable='true'], [role='textbox']";

const STEP_HANDOFF_KEY = "cf:step-handoff";

/**
 * Remember which step to land on across a route change this app initiates itself.
 *
 * H5: a first save moves `/brief/new` to `/brief/{id}`. Those are different route
 * segments, so the page component is remounted. This is a one-shot baton, consumed
 * on read, not a persisted preference. `localStorage`, like every other `cf:` key
 * here — the read deletes it, so nothing is kept, and it is the store this app's
 * test harness stands in for.
 */
export function stashStep(id: string): void {
  try {
    localStorage.setItem(STEP_HANDOFF_KEY, id);
  } catch {
    /* storage blocked — nothing is carried, which is the behaviour without this at all */
  }
}

/**
 * Read and clear the baton. Reading it is what spends it.
 *
 * Exported so a caller that must spend without applying (the create seed, when it
 * refuses a payload) can do so without this module learning what a seed is — the
 * baton stays a generic one-shot.
 */
export function takeStashedStep(): string | null {
  try {
    const id = localStorage.getItem(STEP_HANDOFF_KEY);
    localStorage.removeItem(STEP_HANDOFF_KEY);
    return id;
  } catch {
    return null;
  }
}

/**
 * Whether a key landed inside something that types. A ⌘Z in a text field is the
 * field's own undo; answering it is how an editor eats the keystroke the user
 * aimed at their own words.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  // A keydown aimed at the window or the document was not aimed at a field at all.
  if (!(target instanceof Element)) return false;
  return target.closest(TYPING_SELECTOR) !== null;
}
