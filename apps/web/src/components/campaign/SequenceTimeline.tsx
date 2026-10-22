"use client";

import {
  memo,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";
import {
  MOTION_FPS,
  encodedDurationSec,
} from "@campaignfoundry/CampaignOrchestration/motion-kinds";
import { MIN_DWELL_SEC } from "@campaignfoundry/CampaignOrchestration/copy-timeline";
import type { SurfaceHost } from "@/components/campaign/PreviewDock";
import * as messages from "@/components/campaign/messages";
import type { TrackDiamond, UnplaceableTracks } from "@/components/campaign/track-diamonds";
import type { SequenceVideoRow } from "@/components/campaign/layer-stack-props";
import {
  BeatBoundary,
  Diamond,
  FilmPerforations,
  Nudge,
  Playhead,
  PlayheadSlider,
  Ruler,
  TAPE_END_PAD_PX,
  TAPE_LABEL_PX,
  TAPE_PX_MAX,
  TAPE_PX_MIN,
  TimelineTapeBeat,
  canvasWidth,
  formatTapeClock,
  laneWidth,
  useTapeTransport,
} from "@/components/campaign/TimelineTape";

/**
 * The video creative's sequence timeline (VT1,
 * `2026-10-12_motion-sequence-editor.md` §5): the program-monitor-and-tracks
 * surface a `video` creative gets under its preview, where `TimelineTape` stays
 * the surface for other motion looks (VT-D1).
 *
 * The rules this module lives by are the tape's, inherited rather than restated:
 *
 * **No writer here.** The module imports no reducer and names no action (the
 * word itself is absent, the same source test `TimelineTape` lives under):
 * every edit leaves through a callback the one owner (`BriefEditor`, or the
 * Copy section's narrow host) wires, and commits ONCE, on release — never per
 * pointermove, which is the preview-cost rule TS1's acceptance (b) forbade.
 * Scrub stays the owner's live/commit split (VE-D5); clip drags and boundary
 * slides commit on pointerup.
 *
 * **Weights, never seconds, on every write path** (VT-D2, D1). The beats arrive
 * already resolved by `resolveTimeline` in the parent — this component never
 * divides a weight — and the only seconds it computes are display ones against
 * the previewed duration. A reorder is `onMoveBeat({ from, to })`; a resize is
 * the neighbour transfer `onBoundaryCommit(boundary, delta)`, offered only at
 * INTERNAL joins, because the outer edges of the sequence are not boundaries.
 *
 * **Honest rows.** Every video layer is a full-duration row, disabled ones
 * included (VT-D7: a hidden row stays here, with its enable control, because
 * filtering it would remove the only thing that can turn it back on); the
 * music bed is display-only (VT-D5); nothing plays (VT-D6), so there is no
 * play control at all — not a disabled one — and video and bed clips say they
 * cannot be trimmed rather than offering a trim that would be a lie.
 *
 * Wrapped in `memo` for the same reason the tape is: the rail re-renders on
 * keystrokes this component does not draw.
 */

/* ── The shape the parents project ─────────────────────────────────────────── */

/**
 * The text track's clips: the copy timeline's beats, projected by the parent
 * with `resolveTimeline`. The same row the tape takes, so the two surfaces can
 * never disagree about the same beat.
 */
export type SequenceBeat = TimelineTapeBeat;

export interface SequenceTimelineProps {
  /** The previewed clip length: the axis every x below is measured on. */
  readonly durationSec: number;
  /** `resolveTimeline`'s windows, mapped once by the parent. */
  readonly beats: readonly SequenceBeat[];
  /** The SHORTEST duration the axis can draw — where the dwell floor binds. */
  readonly shortestDurationSec: number;
  /** The live second: what the painted playhead follows. */
  readonly scrubSec: number;
  /** The committed second: what the frame on screen is. */
  readonly committedSec: number;
  /** D139 — ephemeral selection, owned by the parent, never a document field. */
  readonly selectedBeatIndex: number | null;
  /** Live write: the range's `onChange`, which fires all through a drag. */
  readonly onScrubLive: (sec: number) => void;
  /** Commit: pointer release, key-up, a ±1 s nudge, or a click on the ruler. */
  readonly onScrubCommit: (sec: number) => void;
  readonly onSelectBeat: (index: number) => void;
  /**
   * Reorder — one call, on release (or an arrow key, which is a release-sized
   * gesture). The parent keeps the persisted poster on the same text; this
   * component only reports the drop.
   */
  readonly onMoveBeat: (from: number, to: number) => void;
  /**
   * TL3's neighbour transfer, one call on release, offered only at an internal
   * join. The outer edges of the sequence, and a one-beat sequence, have no
   * handle — an inert slider would be an affordance the surface does not have.
   */
  readonly onBoundaryCommit: (boundary: number, delta: number) => void;
  /** Every video layer as a full-duration row, disabled ones included. */
  readonly videoRows: readonly SequenceVideoRow[];
  /**
   * The picked layer, the same id the layer stack and the inspector read —
   * absent means this host has no layer pick to offer (the section host), and
   * the video rows draw as plain boxes instead of controls.
   */
  readonly selectedLayerId?: string | null;
  readonly onSelectLayer?: (id: string) => void;
  /** VT-D7 — hide/enable, the same `setLayerEnabled` the layer stack offers. */
  readonly onSetLayerEnabled: (id: string, enabled: boolean) => void;
  /** Reorder in the stack (z-order), never a time shift: a video layer has no span. */
  readonly onMoveLayer: (from: number, to: number) => void;
  /** Add another video layer — legal and uncapped for this type. */
  readonly onAddVideo: () => void;
  /** VT-D4 — the text offer is present but disabled once the one layer exists. */
  readonly canAddText: boolean;
  readonly onAddText: () => void;
  /** TL4 — the brief's music bed, present only when it carries one. Display only. */
  readonly audioPath?: string;
  /**
   * TL6 / VT-D8 — the picked layer's pose-clock stops, and the count this ruler
   * cannot honestly place. They stay HERE in VT1 because no other surface draws
   * them; `TrackForm` remains the numeric editor.
   */
  readonly diamonds?: {
    readonly placed: readonly TrackDiamond[];
    readonly unplaceable: UnplaceableTracks;
  };
  /** Called ONCE, on release — never per pointermove. */
  readonly onDiamondCommit?: (trackIndex: number, stopIndex: number, sec: number) => void;
  /** Which host mounted it (D145 rail, D146 Copy section). Reflected, not styled. */
  readonly host: SurfaceHost;
}

/* ── Pieces the tape already owns ──────────────────────────────────────────── */

/**
 * A lane: a sticky header column (with this surface's per-row offers, which is
 * why it is not the tape's own `Lane`) and a canvas the clips are placed on.
 */
function Lane({
  header,
  durationSec,
  pxPerSec,
  canvasRef,
  children,
}: {
  header: ReactNode;
  durationSec: number;
  pxPerSec: number;
  canvasRef?: React.RefObject<HTMLDivElement | null>;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="grid h-11 grid-cols-[var(--tt-label)_1fr] items-center">
      <div className="sticky left-0 z-10 flex h-full flex-col items-center justify-center gap-0.5 border-r border-border bg-background font-mono text-[9px] uppercase tracking-eyebrow text-text-muted">
        {header}
      </div>
      <div
        ref={canvasRef}
        className="relative h-full"
        style={{ width: laneWidth(durationSec, pxPerSec) }}
      >
        {children}
      </div>
    </div>
  );
}

/** The header's tiny track controls: named in the messages file, never a bare glyph. */
function TrackButton({
  name,
  onClick,
  disabled,
  children,
}: {
  name: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <button
      type="button"
      aria-label={name}
      title={name}
      disabled={disabled}
      onClick={onClick}
      className="flex size-4 items-center justify-center rounded-sm text-[9px] leading-none text-text-muted transition-colors duration-fast hover:text-text-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/* ── The timeline ──────────────────────────────────────────────────────────── */

function SequenceTimelineImpl(props: SequenceTimelineProps): ReactNode {
  const { durationSec, beats, shortestDurationSec, scrubSec, committedSec, host } = props;

  const { scrollRef, pxPerSec, onZoom, committed, commit, commitFromCanvas } = useTapeTransport({
    durationSec,
    committedSec,
    onScrubCommit: props.onScrubCommit,
  });
  const statusId = "sequence-timeline-status";
  /** Per-instance ids: nothing here may assume it is mounted once per document. */
  const uid = useId();
  const addTextDescId = `${uid}-add-text-blocked`;

  /**
   * One beat's dwell where the floor binds — its own number, not a
   * neighbour's. Every caller has already checked `underFloor` (the status's
   * `find`, the clip's sr-only span, the boundary's two sides), so there is
   * no arm for a beat outside the floor: no such call exists.
   */
  const dwellTextFor = (beat: SequenceBeat): string =>
    messages.timelineDwellUnderFloor(
      (beat.endT - beat.startT) * shortestDurationSec,
      MIN_DWELL_SEC,
    );

  /* ── The text clip drag: one commit, on release (§7's preview-cost rule) ── */

  const textCanvasRef = useRef<HTMLDivElement | null>(null);
  /**
   * The in-flight drag, painted only. `overIndex` is view state — a drop target
   * the operator can see — and the ONLY thing a pointermove writes. The brief is
   * touched exactly once, on pointerup, through `onMoveBeat`.
   */
  const [drag, setDrag] = useState<{ readonly from: number; readonly overIndex: number } | null>(
    null,
  );
  /** The same drag, as a ref: the pointerup handler must read the last move. */
  const dragRef = useRef<{ from: number; overIndex: number } | null>(null);
  /**
   * Whether the pointer travelled between down and up. A click that moved
   * nothing is a SELECTION, and must not also read as a reorder onto itself —
   * and a drag must not also read as a selection of the slot it left.
   */
  const dragMovedRef = useRef(false);

  /**
   * Where a keyboard move's focus goes. The clips are keyed by INDEX, so a
   * reorder reuses the DOM slot the operator pressed and focus would stay on
   * the neighbour now living there — the next arrow would move the wrong
   * beat. The press records the beat's destination and its words, and the
   * effect moves focus there once the parent lands the moved `beats`.
   *
   * The next `beats` change always disarms the press, and focus moves only when
   * the pressed beat is really at its destination: a move the parent refused
   * renders nothing (this component is memoised), so the first `beats` change
   * after it may be an unrelated edit, and that must not pull focus to a stale
   * index (or past the end of a shorter list).
   */
  const keyboardMoveRef = useRef<{ readonly target: number; readonly text: string } | null>(null);
  useEffect(() => {
    const armed = keyboardMoveRef.current;
    if (armed === null) return;
    keyboardMoveRef.current = null;
    if (beats[armed.target]?.text !== armed.text) return;
    const target = armed.target;
    // The same no-null-arm argument as `beatIndexAt` below: the ref is armed
    // only by a clip's own keydown, the clips are this canvas's children, and
    // the arming press already bounds the target inside the sequence — so
    // there is no armed run with the canvas unmounted and no missing clip to
    // fall back for.
    const clips = textCanvasRef.current!.querySelectorAll<HTMLButtonElement>(
      '[data-sequence-clip="text"]',
    );
    clips[target]!.focus();
  }, [beats]);

  /** Which beat the pointer's x falls in, clamped to the sequence's ends. */
  const beatIndexAt = (clientX: number): number => {
    // The only caller is a beat button's pointermove, and those buttons are
    // children of the canvas div this ref names — so the pointer pair cannot
    // fire while the canvas is unmounted and the ref unset. There is no null
    // canvas to read a zero left from, and no arm here for one.
    const left = textCanvasRef.current!.getBoundingClientRect().left;
    const sec = (clientX - left) / pxPerSec;
    for (let index = 0; index < beats.length; index += 1) {
      if (sec < beats[index]!.endT * durationSec) return index;
    }
    return beats.length - 1;
  };

  const onBeatPointerDown = (index: number, e: React.PointerEvent<HTMLButtonElement>) => {
    // Feature-detected: a browser keeps the move/up pair flowing to the clip
    // once the pointer leaves it; a host without the API still gets the pair
    // while the pointer stays inside, which is the happy-dom case.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragMovedRef.current = false;
    const next = { from: index, overIndex: index };
    dragRef.current = next;
    setDrag(next);
  };
  const onBeatPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (dragRef.current === null) return;
    const next = { from: dragRef.current.from, overIndex: beatIndexAt(e.clientX) };
    dragRef.current = next;
    setDrag(next);
    // Moved means the pointer reached a DIFFERENT beat, not that it moved at
    // all: a 1 px wobble never leaves the clip's own window, and a click that
    // went nowhere is still a selection (see `dragMovedRef` above) — marking
    // every move as moved is what lost those clicks.
    if (next.overIndex !== next.from) dragMovedRef.current = true;
  };
  const onBeatPointerUp = () => {
    const current = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    // The one write of the gesture. A drop on the beat's own window is no move.
    if (current !== null && current.overIndex !== current.from) {
      props.onMoveBeat(current.from, current.overIndex);
    }
  };
  /**
   * The touch takeover this drag can lose to (see `touch-none` on the clips):
   * a scrollport that claims the pointer CANCELS it rather than releasing it,
   * so this is the gesture's end — the one write must not happen, and the
   * paint and the moved mark clear as though it never began.
   */
  const onBeatPointerCancel = () => {
    dragRef.current = null;
    setDrag(null);
    dragMovedRef.current = false;
  };

  const onBoundaryCommit = props.onBoundaryCommit;
  const onDiamondCommit = props.onDiamondCommit;
  const videoRows = props.videoRows;

  const breached = beats.find((beat) => beat.underFloor);
  const statusSentence =
    breached !== undefined
      ? dwellTextFor(breached)
      : committed
        ? messages.tapeCommittedStatus(formatTapeClock(committedSec))
        : messages.tapeIdleStatus;

  return (
    <div
      className="sequence-timeline rounded-lg border border-border bg-background"
      data-sequence-host={host}
      style={
        {
          "--tt-label": `${TAPE_LABEL_PX}px`,
          "--tt-end-pad": `${TAPE_END_PAD_PX}px`,
          "--tt-px": pxPerSec,
          "--tt-duration": durationSec,
        } as CSSProperties
      }
    >
      <div className="flex items-baseline justify-between px-3 pb-2 pt-3">
        <h2 className="text-sm font-semibold text-text-emphasis">{messages.sequenceLegend}</h2>
        <p className="font-mono text-[11px] uppercase tracking-eyebrow text-text-muted">
          {messages.tapePxPerSecond(pxPerSec)}
        </p>
      </div>

      {/* One scrollport for the ruler, every lane and the playhead (TS1). */}
      <div
        ref={scrollRef}
        data-sequence-scrollport=""
        className="relative overflow-x-auto overflow-y-hidden overscroll-x-contain border-y border-border"
        onClick={commitFromCanvas}
      >
        <div
          data-sequence-canvas=""
          className="relative"
          style={{ width: canvasWidth(durationSec, pxPerSec), minHeight: "11.75rem" }}
        >
          <Ruler durationSec={durationSec} pxPerSec={pxPerSec} />

          {/* The text track: the copy timeline's beats as clips, draggable to
              reorder (on release) and resizable at internal joins. */}
          <Lane
            header={<span>{messages.tapeLaneTitle}</span>}
            durationSec={durationSec}
            pxPerSec={pxPerSec}
            canvasRef={textCanvasRef}
          >
            {beats.map((beat, index) => {
              const startSec = beat.startT * durationSec;
              const endSec = beat.endT * durationSec;
              const name = messages.sequenceBeatClip(index + 1, startSec, endSec);
              const dwellId = `${uid}-dwell-${index}`;
              const isDragSource = drag !== null && drag.from === index;
              const isDropTarget = drag !== null && drag.overIndex === index && drag.from !== index;
              return (
                <button
                  key={index}
                  type="button"
                  aria-label={name}
                  aria-pressed={props.selectedBeatIndex === index}
                  aria-invalid={beat.underFloor === true ? true : undefined}
                  aria-describedby={beat.underFloor ? dwellId : undefined}
                  title={beat.text}
                  data-sequence-clip="text"
                  className={cn(
                    "absolute bottom-1 top-1 overflow-hidden rounded-md border border-modified/50 bg-modified/20 text-left text-modified transition-colors duration-fast",
                    "cursor-grab touch-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary",
                    props.selectedBeatIndex === index &&
                      "border-brand-primary shadow-[0_0_0_2px] shadow-brand-primary/30",
                    beat.underFloor === true && "border-error/50 bg-error/20 text-error",
                    isDragSource && "opacity-60",
                    isDropTarget && "border-brand-primary",
                  )}
                  style={{
                    left: `calc(${startSec} * ${pxPerSec}px)`,
                    width: `calc(${(endSec - startSec) * pxPerSec}px)`,
                  }}
                  onPointerDown={(e) => onBeatPointerDown(index, e)}
                  onPointerMove={onBeatPointerMove}
                  onPointerUp={onBeatPointerUp}
                  onPointerCancel={onBeatPointerCancel}
                  onKeyDown={(e) => {
                    // The keyboard reorder: one snap step, the same size as the
                    // Copy form's own arrows, and the same one release-sized call.
                    // Auto-repeat is not a run of those calls — one held key is
                    // one gesture, the way one drag is.
                    if (e.repeat) return;
                    if (e.key === "ArrowLeft" && index > 0) {
                      e.preventDefault();
                      keyboardMoveRef.current = { target: index - 1, text: beat.text };
                      props.onMoveBeat(index, index - 1);
                    } else if (e.key === "ArrowRight" && index < beats.length - 1) {
                      e.preventDefault();
                      keyboardMoveRef.current = { target: index + 1, text: beat.text };
                      props.onMoveBeat(index, index + 1);
                    }
                  }}
                  onClick={() => {
                    // A drag's trailing click is not a selection, and a click
                    // that never moved is not a reorder.
                    if (dragMovedRef.current) {
                      dragMovedRef.current = false;
                      return;
                    }
                    props.onSelectBeat(index);
                  }}
                >
                  <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[11px] font-semibold">
                    {messages.tapeBeatName(index + 1)}
                  </span>
                  {beat.underFloor ? (
                    <span id={dwellId} className="sr-only">
                      {dwellTextFor(beat)}
                    </span>
                  ) : null}
                </button>
              );
            })}
            {/* One handle per INTERNAL join. The outer edges are not
                boundaries, and a one-beat sequence has no join at all. */}
            {beats.length > 1
              ? beats.slice(0, -1).map((left, index) => {
                  const right = beats[index + 1]!;
                  const underFloorText = left.underFloor
                    ? dwellTextFor(left)
                    : right.underFloor
                      ? dwellTextFor(right)
                      : undefined;
                  return (
                    <BeatBoundary
                      key={`boundary-${index}`}
                      boundary={index}
                      left={left}
                      right={right}
                      durationSec={durationSec}
                      pxPerSec={pxPerSec}
                      underFloorText={underFloorText}
                      onCommit={(delta) => onBoundaryCommit(index, delta)}
                    />
                  );
                })
              : null}
          </Lane>

          {/* The video tracks: every video layer, disabled ones included, one
              full-duration clip each. No drag, no trim — a video layer has no
              span to write (VT-D2), so the row offers stack order and enable in
              the header and nothing on the clip itself. */}
          {videoRows.map((row, ordinal) => {
            const selected = props.selectedLayerId === row.id;
            const clipName = messages.sequenceVideoClip(ordinal + 1, durationSec);
            const clipClass = cn(
              "absolute inset-y-1 left-0 overflow-hidden rounded-md border bg-brand-tint text-brand-on-tint",
              row.off && "opacity-40",
              selected && "border-brand-primary shadow-[0_0_0_2px] shadow-brand-primary/30",
            );
            const clipStyle = { width: `${durationSec * pxPerSec}px` };
            return (
              <Lane
                key={row.id}
                header={
                  <span className="flex flex-col items-center gap-0.5">
                    <span>{messages.sequenceVideoTrack(ordinal + 1)}</span>
                    <span className="flex items-center gap-0.5">
                      {row.canMoveDown ? (
                        <TrackButton
                          name={messages.sequenceMoveVideoTrackDown(ordinal + 1)}
                          onClick={() => props.onMoveLayer(row.index, row.index - 1)}
                        >
                          ↓
                        </TrackButton>
                      ) : null}
                      {row.canMoveUp ? (
                        <TrackButton
                          name={messages.sequenceMoveVideoTrackUp(ordinal + 1)}
                          onClick={() => props.onMoveLayer(row.index, row.index + 1)}
                        >
                          ↑
                        </TrackButton>
                      ) : null}
                      {row.canToggle ? (
                        <TrackButton
                          name={
                            row.off
                              ? messages.sequenceShowVideoTrack(ordinal + 1)
                              : messages.sequenceHideVideoTrack(ordinal + 1)
                          }
                          onClick={() => props.onSetLayerEnabled(row.id, row.off)}
                        >
                          {row.off ? "○" : "◉"}
                        </TrackButton>
                      ) : null}
                    </span>
                  </span>
                }
                durationSec={durationSec}
                pxPerSec={pxPerSec}
              >
                {/* No handler, no control (the tape's own Clip rule): a row with
                    no layer pick to offer is a plain box, out of the tab order. */}
                {props.onSelectLayer === undefined ? (
                  <div
                    aria-label={clipName}
                    data-sequence-clip="video"
                    title={clipName}
                    className={clipClass}
                    style={clipStyle}
                  >
                    <FilmPerforations />
                  </div>
                ) : (
                  <button
                    type="button"
                    aria-label={clipName}
                    aria-pressed={selected}
                    data-sequence-clip="video"
                    title={clipName}
                    className={clipClass}
                    style={clipStyle}
                    onClick={() => props.onSelectLayer?.(row.id)}
                  >
                    <FilmPerforations />
                  </button>
                )}
              </Lane>
            );
          })}

          {/* TL6 / VT-D8 — the keys lane, present only when the picked layer HAS
              keys, on the host that can commit them. */}
          {props.diamonds !== undefined &&
          (props.diamonds.placed.length > 0 || props.diamonds.unplaceable.count > 0) ? (
            <Lane
              header={<span>{messages.tapeLaneKeyframes}</span>}
              durationSec={durationSec}
              pxPerSec={pxPerSec}
            >
              {props.diamonds.placed.map((diamond) => (
                <Diamond
                  key={`${diamond.trackIndex}:${diamond.stopIndex}`}
                  diamond={diamond}
                  durationSec={durationSec}
                  pxPerSec={pxPerSec}
                  onCommit={(sec) => onDiamondCommit?.(diamond.trackIndex, diamond.stopIndex, sec)}
                />
              ))}
              {props.diamonds.unplaceable.count > 0 ? (
                <p
                  data-tape-keys-unplaced=""
                  className="pl-2 text-[10px] leading-[2.75rem] text-text-muted"
                >
                  {messages.tapeKeysNotPlaced(props.diamonds.unplaceable.count)}
                </p>
              ) : null}
            </Lane>
          ) : null}

          {/* TL4 — the bed's span, present only when the brief carries one.
              Display only: nothing on this lane commits (VT-D5). */}
          {props.audioPath !== undefined ? (
            <Lane
              header={<span>{messages.tapeLaneAudio}</span>}
              durationSec={durationSec}
              pxPerSec={pxPerSec}
            >
              <div
                data-tape-audio-span=""
                aria-hidden="true"
                className="absolute inset-y-2 left-0 rounded bg-brand/20"
                style={{ width: `${durationSec * pxPerSec}px` }}
              />
              <p className="relative pl-2 text-[10px] leading-[2.75rem] text-text-muted">
                {messages.tapeAudioSpan(durationSec, encodedDurationSec(durationSec, MOTION_FPS))}
              </p>
            </Lane>
          ) : null}

          <Playhead
            seconds={scrubSec}
            durationSec={durationSec}
            pxPerSec={pxPerSec}
            committedLabel={formatTapeClock(committedSec)}
          />
        </div>
      </div>

      {/* The transport: nudges, the playhead, the zoom. No play button — not a
          disabled one (VT-D6): a shipped-but-inert play control would teach the
          wrong tool while waiting on a restamp. */}
      <div className="flex items-center gap-2 px-3 py-3">
        <Nudge name={messages.tapeNudgeBack} onClick={() => commit(committedSec - 1)}>
          {messages.tapeNudgeBackGlyph}
        </Nudge>
        <PlayheadSlider
          durationSec={durationSec}
          scrubSec={scrubSec}
          onLive={props.onScrubLive}
          onCommit={commit}
        />
        <Nudge name={messages.tapeNudgeForward} onClick={() => commit(committedSec + 1)}>
          {messages.tapeNudgeForwardGlyph}
        </Nudge>
        <input
          type="range"
          min={TAPE_PX_MIN}
          max={TAPE_PX_MAX}
          step={1}
          value={pxPerSec}
          aria-label={messages.tapeZoomName}
          className="h-10 w-20 shrink-0 cursor-pointer accent-brand-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          onChange={(e) => onZoom(Number(e.target.value))}
        />
      </div>

      {/* Add-track: video is always legal (the type does not cap it); text is
          the shared budget's, so the control stays visible and disabled with
          the reason named, rather than vanishing (VT-D4). */}
      <div
        role="group"
        aria-label={messages.sequenceAddTrackLabel}
        className="flex flex-wrap items-center gap-2 px-3 pt-1"
      >
        <button
          type="button"
          onClick={props.onAddVideo}
          className="rounded-md border border-border-control bg-surface-2 px-2 py-1 text-[11px] text-text-primary transition-colors duration-fast hover:border-border-control-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {messages.sequenceAddVideoTrack}
        </button>
        <span className="flex items-center">
          {!props.canAddText ? (
            <span id={addTextDescId} className="sr-only">
              {messages.sequenceAddTextBlocked}
            </span>
          ) : null}
          <button
            type="button"
            aria-describedby={!props.canAddText ? addTextDescId : undefined}
            disabled={!props.canAddText}
            onClick={props.onAddText}
            className="rounded-md border border-border-control bg-surface-2 px-2 py-1 text-[11px] text-text-primary transition-colors duration-fast hover:border-border-control-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-40"
          >
            {messages.sequenceAddTextTrack}
          </button>
        </span>
        {!props.canAddText ? (
          <span className="text-[11px] text-text-muted">{messages.sequenceAddTextBlocked}</span>
        ) : null}
      </div>

      <p className="px-3 pt-1 text-[11px] text-text-muted">{messages.sequenceFullSpanNote}</p>

      <p id={statusId} role="status" className="px-3 pb-3 pt-1 text-[11px] text-text-muted">
        {statusSentence}
      </p>
    </div>
  );
}

export const SequenceTimeline = memo(SequenceTimelineImpl);
