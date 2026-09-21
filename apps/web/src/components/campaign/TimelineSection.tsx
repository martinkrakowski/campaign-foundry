"use client";

import { useId, useMemo, useState, type Dispatch } from "react";
import { Button, Input, Stepper } from "@/components/ui";
import { cn } from "@/lib/cn";
import { TimelineTape, beatUnderFloor } from "@/components/campaign/TimelineTape";
import { useViewportMinWidth, RAIL_VIEWPORT_MIN_PX } from "@/lib/use-viewport-min-width";
import * as messages from "@/components/campaign/messages";
import {
  addBeatBlockedBy,
  approvedHeadlineTexts,
  asCopyTimeline,
  canSerializeTimeline,
  timelineDurations,
  MAX_WEIGHT,
  MIN_DWELL_SEC,
  type EditorAction,
  type EditorState,
} from "@/components/campaign/editor-state";
import {
  DWELL_TOLERANCE,
  resolveTimeline,
} from "@campaignfoundry/CampaignOrchestration/copy-timeline";

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
 *
 * The third is SG6′, added later: the panel says when the beats it is collecting will
 * not reach the file. `CopySection` renders it on `mode === "variation"` alone, while
 * `toBrief` writes `copy.timeline` on `canSerializeTimeline` and a non-empty list — so
 * before this line an operator could author a sequence, watch `validate.ts` check its
 * weights, save, and find the block absent with nothing having said so. The notice reads
 * the projection's OWN predicate rather than restating its conditions, so it cannot drift
 * from what `toBrief` does; the sentence below it is chosen by which condition is unmet.
 */
export function TimelineSection({
  state,
  dispatch,
  errors = {},
  warnings = {},
  onChooseScene,
  sectionPlayhead,
}: {
  state: EditorState;
  dispatch: Dispatch<EditorAction>;
  errors?: Record<string, string>;
  warnings?: Record<string, string>;
  /** TL2 — open the Asset Bin for one beat. Absent disables the chip: a
   * surface with no picker must not offer a gesture that does nothing. */
  onChooseScene?: (index: number) => void;
  /**
   * TS2 — the committed second, published out of `PlayheadHost`. Absent means
   * no playhead has been published yet (a still draft, or before the rail's
   * first render), and the tape simply does not appear.
   */
  sectionPlayhead?: {
    durationSec: number;
    committedSec: number;
    commit: (sec: number) => void;
  } | null;
}) {
  const beats = state.timeline.beats;
  const blocked = addBeatBlockedBy(state);
  const durations = [...timelineDurations(state)].sort((a, b) => a - b);
  const approved = approvedHeadlineTexts(state.pool);
  // X15's shape, applied outside `Field`: each beat's message element gets a stable id
  // and the controls it is about name it via aria-describedby. An error key here is only
  // ever a share failure (out of range, under the floor) — nothing about the beat's
  // wording — so it describes and invalidates the weight stepper alone. The prohibited
  // terms warning is the only message about the text, and describes the text input.
  const uid = useId();
  // SG6′: the projection's own gate, not a copy of its conditions — a rule restated here
  // would go stale the day `toBrief`'s rule changes and this one does not. An empty
  // sequence is "no timeline" rather than a dropped one, so the count is part of the gate.
  const dropped = beats.length > 0 && !canSerializeTimeline(state);

  const railShown = useViewportMinWidth(RAIL_VIEWPORT_MIN_PX);
  const [selectedBeatIndex, setSelectedBeatIndex] = useState<number | null>(null);
  // No `??` fallbacks: the duration rides the published playhead, and
  // `durations` is non-empty by construction (`timelineDurations` always yields
  // at least the clip). A fallback here would be an unreachable branch.
  const tapeDuration = sectionPlayhead?.durationSec ?? 0;
  const shortestSec = Math.min(...durations);
  const tapeBeats = useMemo(
    () =>
      resolveTimeline(asCopyTimeline(state.timeline), tapeDuration).map((beat, index) => ({
        text: beat.text,
        startT: beat.startT,
        endT: beat.endT,
        weight: beats[index]!.weight,
        underFloor: beatUnderFloor((beat.endT - beat.startT) * shortestSec),
      })),
    [state.timeline, tapeDuration, shortestSec],
  );
  const sectionTape =
    railShown || sectionPlayhead == null || beats.length === 0 ? null : (
      <TimelineTape
        durationSec={tapeDuration}
        beats={tapeBeats}
        shortestDurationSec={shortestSec}
        // Both seconds are the committed one: with no live scrub in this host
        // the diamond sits where the frame is, which is the whole of option A.
        scrubSec={sectionPlayhead.committedSec}
        committedSec={sectionPlayhead.committedSec}
        selectedBeatIndex={selectedBeatIndex}
        onScrubLive={sectionPlayhead.commit}
        onScrubCommit={sectionPlayhead.commit}
        onSelectBeat={setSelectedBeatIndex}
        host="section"
      />
    );

  return (
    <fieldset className="mt-4 space-y-2 border-t border-border pt-3">
      <legend className="text-[11px] text-text-muted">{messages.timelineLegend}</legend>
      <p className="text-[11px] text-text-muted">
        {beats.length === 0 ? messages.timelineEmpty : messages.timelineHelp}
      </p>

      {/* SG6′: the drop is not silent. Muted and a status, like `modeDroppedVideo` — the
          beats are kept, the draft is valid and Save still takes it; the sentence says
          what will not be in the file and which control puts it back. The mode condition
          is not among them: `CopySection` renders this panel only in Randomized, so with
          the panel on screen the unmet condition is Video or the headline pool, and
          naming the wrong section is worse than naming neither. */}
      {dropped ? (
        <p role="status" className="text-[11px] text-text-muted">
          {state.formats.includes("motion")
            ? messages.timelineDroppedHeadlinePool
            : messages.timelineDroppedNoVideo}
        </p>
      ) : null}

      {/* TS2 — D146's section host. The rail owns the tape wherever the rail is
          shown; below its viewport gate there is no rail, so the sequence the
          operator is authoring would otherwise have no playhead at all. Exactly
          one tape is mounted either way, which is the lane's acceptance.

          It follows the COMMITTED second, never the live one: a drag must not
          re-render the step form (`brief-editor.playhead.test.tsx`), and this
          panel is inside it. Scrubbing here commits straight away — the gesture
          is a click on the ruler rather than a drag, which is the owner's
          option A. */}
      {sectionTape}

      {beats.length > 0 ? (
        <ol className="space-y-2">
          {beats.map((beat, index) => {
            const beatError = errors[`copy-timeline-beat-${index}`];
            const beatWarning = warnings[`copy-timeline-beat-${index}`];
            const beatMessageId = `${uid}-beat-message-${index}`;
            // The warning is the only message about the text, and it renders only when no
            // error does — the input is described by it and never by the share error.
            const textWarning = beatError === undefined ? beatWarning : undefined;
            return (
              <li key={beat.key} className="space-y-1">
                <div className="flex items-start gap-2">
                  <Input
                    aria-label={messages.timelineBeatTextLabel(index + 1)}
                    aria-describedby={textWarning ? beatMessageId : undefined}
                    value={beat.text}
                    placeholder={messages.timelineBeatPlaceholder}
                    onChange={(e) => dispatch({ type: "setBeatText", index, text: e.target.value })}
                  />
                  <Stepper
                    aria-label={messages.timelineBeatWeightLabel(index + 1)}
                    aria-describedby={beatError ? beatMessageId : undefined}
                    aria-invalid={beatError ? "true" : undefined}
                    value={String(beat.weight)}
                    min={1}
                    max={MAX_WEIGHT}
                    onChange={(value) =>
                      dispatch({ type: "setBeatWeight", index, weight: Number(value) })
                    }
                  />
                  {/* TL2 — the beat's own scene. A beat naming none shows the
                      creative's ground (VE-D3), and the chip says so rather than
                      leaving the absence unreadable. The cap is NOT counted here:
                      a fourth distinct scene is refused by `scenesProblem`
                      through `validateTimeline`, and this surface only reports
                      it — a local count is the debt this lane exists to stop. */}
                  <span className="flex items-center gap-1">
                    <button
                      type="button"
                      aria-label={messages.timelineBeatSceneLabel(index + 1)}
                      onClick={() => onChooseScene?.(index)}
                      disabled={onChooseScene === undefined}
                      className={cn(
                        "max-w-[10rem] truncate rounded border px-2 py-1 text-[11px]",
                        beat.background === undefined
                          ? "border-border text-text-muted"
                          : "border-accent text-accent",
                      )}
                    >
                      {beat.background === undefined
                        ? messages.timelineBeatSceneNone
                        : beat.background.split("/").pop()}
                    </button>
                    {beat.background === undefined ? null : (
                      <button
                        type="button"
                        aria-label={messages.timelineBeatSceneClearLabel(index + 1)}
                        onClick={() => dispatch({ type: "setBeatBackground", index })}
                        className="rounded border border-border px-2 py-1 text-[11px] text-text-muted"
                      >
                        ×
                      </button>
                    )}
                  </span>
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
                </div>
                {beatError ? (
                  <span id={beatMessageId} className="block text-[11px] text-error">
                    {beatError}
                  </span>
                ) : beatWarning ? (
                  <span id={beatMessageId} className="block text-[11px] text-warning">
                    {beatWarning}
                  </span>
                ) : null}
              </li>
            );
          })}
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
                {transition === "cut"
                  ? messages.timelineTransitionCut
                  : messages.timelineTransitionFade}
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
      <p className="text-[11px] text-text-muted">
        {messages.timelineProportionCaption(durationSec)}
      </p>
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
