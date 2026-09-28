"use client";

/**
 * SG1 — what is left of the wizard's navigation module.
 *
 * This file owned the six-step walk: the step cursor (`useStepNavigation`), the
 * arrow-key and swipe gestures, `useBecameTrue` for the Next button's ready ring,
 * and `STEP_TRANSITION_MS` for the step-card transition. SG-D2 retired the wizard,
 * so all of that is deleted rather than kept as code no surface can reach.
 *
 * The step baton (`stashStep`/`takeStashedStep`) retired too, in PT-5c1: it was
 * written by `CreateCampaignDialog` and spent by `create-campaign.ts`'s `takeSeed`,
 * carrying a step-cursor position across the `/brief/new` → `/brief/{id}` remount
 * (H5). Its APPLIER (the step cursor) was already gone with SG-D2, and the create
 * flow it served (the `cf:create-seed` seam) retired with PT-5c1's move to
 * `POST /campaigns` — so both ends of the baton are gone, and this module's own
 * comment named exactly this lane as the one to cut it. `isTypingTarget` is the
 * one export left, read by `editor-history.ts`'s undo chord (VE1), which asks the
 * same question for the same reason: a ⌘Z inside a text field belongs to the
 * field's own undo, not to the editor's.
 */

/** The places a keystroke lands *inside* something that types. */
const TYPING_SELECTOR = "input, textarea, select, [contenteditable='true'], [role='textbox']";

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
