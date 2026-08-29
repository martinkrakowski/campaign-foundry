"use client";

import type { Dispatch } from "react";
import { Button, Input, Stepper } from "@/components/ui";
import { cn } from "@/lib/cn";
import * as messages from "@/components/campaign/messages";
import {
  addBeatBlockedBy,
  approvedHeadlineTexts,
  asCopyTimeline,
  timelineDurations,
  MAX_WEIGHT,
  MIN_DWELL_SEC,
  type EditorAction,
  type EditorState,
} from "@/components/campaign/editor-state";
import { DWELL_TOLERANCE, resolveTimeline } from "@campaignfoundry/CampaignOrchestration/copy-timeline";

/**
 * The copy-timeline sub-panel (E5.2 / E5.3).
 *
 * Two things here are load-bearing rather than decorative.
 *
 * The proportion bar reads `resolveTimeline` — the compositor's own function — rather than
 * dividing weights itself. A bar that computed its own shares would be right until the
 * domain changed how a window is derived, and then quietly wrong; a test pins the two
 * together for exactly that reason.
 *
 * *Add beat* is disabled with a stated reason, and the reason is re-derived on every
 * render from the current duration axis. The floor can be breached by narrowing that axis
 * with every control still enabled, so detection cannot live in the add path alone. What
 * the editor guarantees is detection plus refusal to run (D7/D11) — not prevention.
 */
export function TimelineSection({
  state,
  dispatch,
}: {
  state: EditorState;
  dispatch: Dispatch<EditorAction>;
}) {
  const beats = state.timeline.beats;
  const blocked = addBeatBlockedBy(state);
  const durations = [...timelineDurations(state)].sort((a, b) => a - b);
  const approved = approvedHeadlineTexts(state.pool);

  return (
    <fieldset className="mt-4 space-y-2 border-t border-border pt-3">
      <legend className="text-[11px] text-text-muted">{messages.timelineLegend}</legend>
      <p className="text-[11px] text-text-muted">
        {beats.length === 0 ? messages.timelineEmpty : messages.timelineHelp}
      </p>

      {beats.length > 0 ? (
        <ol className="space-y-2">
          {beats.map((beat, index) => (
            <li key={beat.key} className="flex items-start gap-2">
              <Input
                aria-label={messages.timelineBeatTextLabel(index + 1)}
                value={beat.text}
                placeholder={messages.timelineBeatPlaceholder}
                onChange={(e) => dispatch({ type: "setBeatText", index, text: e.target.value })}
              />
              <Stepper
                aria-label={messages.timelineBeatWeightLabel(index + 1)}
                value={String(beat.weight)}
                min={1}
                max={MAX_WEIGHT}
                onChange={(value) => dispatch({ type: "setBeatWeight", index, weight: Number(value) })}
              />
              <button
                type="button"
                aria-label={messages.timelineKeyBeatLabel(index + 1)}
                aria-pressed={state.timeline.keyBeat === index + 1}
                onClick={() => dispatch({ type: "setKeyBeat", index })}
                className={cn(
                  "rounded border px-2 py-1 text-[11px]",
                  state.timeline.keyBeat === index + 1
                    ? "border-accent text-accent"
                    : "border-border text-text-muted",
                )}
              >
                {messages.timelineKeyBeatLegend}
              </button>
              <button
                type="button"
                aria-label={messages.timelineMoveBeatUp(index + 1)}
                disabled={index === 0}
                onClick={() => dispatch({ type: "moveBeat", from: index, to: index - 1 })}
                className="rounded border border-border px-2 py-1 text-[11px] disabled:opacity-40"
              >
                ↑
              </button>
              <button
                type="button"
                aria-label={messages.timelineMoveBeatDown(index + 1)}
                disabled={index === beats.length - 1}
                onClick={() => dispatch({ type: "moveBeat", from: index, to: index + 1 })}
                className="rounded border border-border px-2 py-1 text-[11px] disabled:opacity-40"
              >
                ↓
              </button>
              <button
                type="button"
                aria-label={messages.timelineRemoveBeat(index + 1)}
                onClick={() => dispatch({ type: "removeBeat", index })}
                className="rounded border border-border px-2 py-1 text-[11px] text-text-muted"
              >
                ×
              </button>
            </li>
          ))}
        </ol>
      ) : null}

      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          type="button"
          disabled={blocked !== undefined}
          onClick={() => dispatch({ type: "addBeat" })}
        >
          {messages.timelineAddBeat}
        </Button>
        {blocked ? (
          <span className="text-[11px] text-text-muted">
            {blocked.kind === "max"
              ? messages.timelineAddBlockedMax(blocked.max)
              : messages.timelineAddBlockedFloor(blocked.shortestSec, blocked.floorSec)}
          </span>
        ) : null}
      </div>

      {/* E5.4 — insert approved copy. Offered only when the pool holds some and a beat can
          still be added, so the control is never present-but-inert. */}
      {approved.length > 0 && blocked === undefined ? (
        <fieldset className="flex flex-wrap items-center gap-2">
          <legend className="text-[11px] text-text-muted">{messages.timelineInsertLegend}</legend>
          {approved.map((text) => (
            <button
              key={text}
              type="button"
              aria-label={messages.timelineInsertBeat(text)}
              onClick={() => dispatch({ type: "addBeat", text })}
              className="max-w-[16rem] truncate rounded border border-border px-2 py-1 text-[11px] text-text-muted"
            >
              {text}
            </button>
          ))}
        </fieldset>
      ) : null}

      {beats.length > 0 ? (
        <>
          <fieldset className="flex items-center gap-2">
            <legend className="sr-only">{messages.timelineTransitionLegend}</legend>
            {(["cut", "fade"] as const).map((transition) => (
              <button
                key={transition}
                type="button"
                aria-pressed={state.timeline.transition === transition}
                onClick={() => dispatch({ type: "setTransition", transition })}
                className={cn(
                  "rounded border px-2 py-1 text-[11px]",
                  state.timeline.transition === transition
                    ? "border-accent text-accent"
                    : "border-border text-text-muted",
                )}
              >
                {transition === "cut" ? messages.timelineTransitionCut : messages.timelineTransitionFade}
              </button>
            ))}
          </fieldset>

          {durations.map((durationSec) => (
            <ProportionBar key={durationSec} state={state} durationSec={durationSec} />
          ))}
        </>
      ) : null}
    </fieldset>
  );
}

/**
 * One clip length's share of the sequence.
 *
 * Every number shown comes from `resolveTimeline`; nothing here divides a weight. A beat
 * under the floor is marked on the bar as well as in its label, so the breach is visible
 * without reading each row — including the breach a narrowed duration axis creates while
 * every control stays enabled.
 */
function ProportionBar({ state, durationSec }: { state: EditorState; durationSec: number }) {
  const resolved = resolveTimeline(asCopyTimeline(state.timeline), durationSec);
  return (
    <div className="space-y-1">
      <p className="text-[11px] text-text-muted">{messages.timelineProportionCaption(durationSec)}</p>
      <div className="flex h-6 w-full overflow-hidden rounded border border-border">
        {resolved.map((beat, index) => {
          const dwellSec = (beat.endT - beat.startT) * durationSec;
          // The domain's own slack, imported not restated: 3 × 1.2 is 3.5999999999999996,
          // so a strict comparison paints a beat red that `timelineProblem` accepts — the
          // bar and the validator disagreeing about the same draft.
          const underFloor = dwellSec < MIN_DWELL_SEC - DWELL_TOLERANCE;
          return (
            <span
              key={index}
              style={{ width: `${(beat.endT - beat.startT) * 100}%` }}
              title={
                underFloor
                  ? messages.timelineDwellUnderFloor(dwellSec, MIN_DWELL_SEC)
                  : messages.timelineDwell(dwellSec)
              }
              className={cn(
                "flex items-center justify-center overflow-hidden whitespace-nowrap border-r border-border px-1 text-[10px] last:border-r-0",
                underFloor ? "bg-error/20 text-error" : "text-text-muted",
              )}
            >
              {underFloor
                ? messages.timelineDwellUnderFloor(dwellSec, MIN_DWELL_SEC)
                : messages.timelineDwell(dwellSec)}
            </span>
          );
        })}
      </div>
    </div>
  );
}
