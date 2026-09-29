import type { WaveEvent } from "../../wave-status/lib/types.js";

/** The latest `<stage> settled` event for (wave, lane), in log order, or undefined. */
function latestStageSettled(
  events: readonly WaveEvent[],
  wave: string,
  lane: string,
  stage: WaveEvent["stage"],
): { readonly event: WaveEvent; readonly index: number } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.wave !== wave) continue;
    if (event.lane !== lane) continue;
    if (event.stage !== stage || event.event !== "settled") continue;
    return { event, index: i };
  }
  return undefined;
}

/** Is there a `remediate settled` for (wave, lane) strictly after `afterIndex`, in log order? */
function hasLaterRemediateSettled(
  events: readonly WaveEvent[],
  wave: string,
  lane: string,
  afterIndex: number,
): boolean {
  for (let i = afterIndex + 1; i < events.length; i++) {
    const event = events[i];
    if (
      event.wave === wave &&
      event.lane === lane &&
      event.stage === "remediate" &&
      event.event === "settled"
    ) {
      return true;
    }
  }
  return false;
}

/**
 * D184's pre-PR-review gate for a `high`-risk lane: `undefined` when a merge
 * may proceed, or the reason it may not — naming the missing event — when it
 * may not.
 *
 * The wave log must hold `stage=review event=settled` for this lane. When
 * that event's `detail.verdict` is `changes-required`, a LATER
 * `stage=remediate event=settled` for the same lane must follow it in log
 * order too. Any other verdict on the review — `clear`, or none recorded at
 * all — needs nothing further: the review itself is enough.
 *
 * "Latest" and "later" are both LOG ORDER, never a timestamp comparison —
 * the same reason `governingPlanReview` gives: wave-event.sh records whole
 * seconds, so two events in the same second are still ordered by the log.
 */
export function prePrReviewRefusal(
  events: readonly WaveEvent[],
  wave: string,
  lane: string,
): string | undefined {
  const review = latestStageSettled(events, wave, lane, "review");
  if (review === undefined) {
    return `no stage=review event=settled for lane ${lane} in wave ${wave}`;
  }
  if (
    review.event.detail?.verdict === "changes-required" &&
    !hasLaterRemediateSettled(events, wave, lane, review.index)
  ) {
    return (
      `stage=review event=settled for lane ${lane} in wave ${wave} ended changes-required ` +
      `with no later stage=remediate event=settled`
    );
  }
  return undefined;
}
