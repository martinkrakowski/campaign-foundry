"use client";

import {
  memo,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";
import { useInlineWidth } from "@/lib/use-min-inline-size";
import { MOTION_FPS } from "@campaignfoundry/CampaignOrchestration/motion-kinds";
import {
  DWELL_TOLERANCE,
  MIN_DWELL_SEC,
} from "@campaignfoundry/CampaignOrchestration/copy-timeline";
import * as messages from "@/components/campaign/messages";

/**
 * The time surface: one scrollport that owns the ruler, the lanes and the
 * playhead, drawn in DESIGN.md tokens (TS1, `2026-09-16_rail-timeline-surface.md`).
 *
 * Three things here are load-bearing rather than decorative.
 *
 * **One scrollport.** The ruler, every lane and the playhead share a single
 * `overflow-x-auto` box, so they share one `scrollLeft` by construction. The HTML
 * sketch this plan replaces put the ruler in its own `overflow-hidden` wrapper,
 * and the two drifted apart the moment anybody scrolled — the cutoff defect the
 * plan's §3.2 names. The canvas is `label + duration * pxPerSec + endPad` wide,
 * and the end pad is why the last second is not clipped by the well's radius.
 *
 * **Nothing here plays.** There is no animation-frame loop, no interval timer and
 * no media element: the compositor is the only renderer (VE-D2) and scrubbing is
 * user-driven, never autoplaying (VE-D5). A browser clock here would be a second
 * renderer with a different clock than `round(atSec / durationSec × (frames − 1))`.
 *
 * **Scrub is not an action.** This module imports no reducer and dispatches
 * nothing (VE-D5, D139). The two seconds arrive as props from the one owner
 * (`PlayheadHost`, `BriefEditor.tsx`) and leave through two callbacks. The
 * painted diamond follows the LIVE second; the frame request follows the
 * COMMITTED one, which is what keeps a drag off the network.
 *
 * Wrapped in `memo` for the same reason `PreviewDock` is: the rail re-renders on
 * keystrokes this component does not draw, and its props are value-stable across
 * one (CC1/CC2).
 */

/* ── Layout constants ─────────────────────────────────────────────────────── */

/**
 * This component's own layout, the way `DurationStrip`'s `TOTAL_SECONDS = 30` is
 * local to it — not a second design-token file. They are exported because the
 * fit arithmetic and its tests are the same numbers.
 */
export const TAPE_LABEL_PX = 52;
export const TAPE_END_PAD_PX = 32;
export const TAPE_PX_MIN = 28;
export const TAPE_PX_MAX = 96;
/**
 * Fit never zooms IN past this, only out: a 3 s clip stretched across a desktop
 * rail would put four seconds of empty canvas after the last one and read as a
 * much longer clip than it is.
 */
export const TAPE_PX_FIT_MAX = 48;

/**
 * Pixels per second that show the whole clip inside `scrollportWidth`.
 *
 * A port that has not been laid out yet (happy-dom, and the first client paint
 * before `ResizeObserver` reports) measures 0, which makes `available` negative:
 * that is "no measurement", not "no room", and the honest answer is the minimum
 * zoom rather than a division by a width nobody has.
 */
export function fitPx(scrollportWidth: number, durationSec: number): number {
  const available = scrollportWidth - TAPE_LABEL_PX - TAPE_END_PAD_PX;
  if (available <= 0 || durationSec <= 0) return TAPE_PX_MIN;
  return Math.max(TAPE_PX_MIN, Math.min(TAPE_PX_FIT_MAX, Math.floor(available / durationSec)));
}

/**
 * The playback clock the operator reads, e.g. `00:06.40` — floored, because a
 * label that rounds UP names a frame the scrub has not reached yet.
 *
 * `PreviewDock` shows no number at all (its range is a bare thumb), so there was
 * no existing `fmt` to reuse and this is the tape's own — deliberately the only
 * one, shared by the playhead readout and the status sentence so they cannot
 * disagree about the same second.
 *
 * The centisecond is taken from `seconds * 100` with a hair of slack, not from
 * the fractional part: `6.4 - 6` is `0.3999999999999995` in IEEE-754, and
 * flooring that names `00:06.39` for a second the slider calls 6.4.
 */
export function formatTapeClock(seconds: number): string {
  const safe = Math.max(0, seconds);
  const centis = Math.floor(safe * 100 + 1e-6);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(centis / 6000))}:${pad(Math.floor(centis / 100) % 60)}.${pad(centis % 100)}`;
}

/**
 * One formula for every horizontal position, so the painted diamond, the ruler
 * ticks and the clips cannot drift from each other by rounding differently.
 *
 * The label column is spelled as its own constant rather than `var(--tt-label)`
 * (the plan's §3.5 spelling) for one reason, and it is a testability one:
 * happy-dom rejects a `calc()` that contains a `var()` OUTRIGHT — the declaration
 * is dropped and `style.left` reads as the empty string — so §8's own proof for
 * this lane ("the windows become `style.width` / `style.left` strings that
 * contain the computed seconds, a string match on the `calc(...)`") cannot be
 * made at all with that spelling. The number is still written once, here and in
 * `canvasWidth` below, from the same exported constant the custom property is
 * set from, so there is no second source of truth to drift — and the properties
 * themselves still ship on the root, where the lane grid's own
 * `grid-cols-[var(--tt-label)_1fr]` reads them.
 */
function xFor(seconds: number, pxPerSec: number): string {
  return `calc(${TAPE_LABEL_PX}px + ${seconds} * ${pxPerSec}px)`;
}

/**
 * The canvas: the label column, the clip itself, and the END PAD — which is the
 * whole cutoff fix. Without it the playhead at `t = durationSec` sits on the
 * well's border-radius and loses its knob, which is what the HTML sketch did.
 */
function canvasWidth(durationSec: number, pxPerSec: number): string {
  return `calc(${TAPE_LABEL_PX}px + ${durationSec} * ${pxPerSec}px + ${TAPE_END_PAD_PX}px)`;
}

/** A lane's own canvas: the clip length plus the same end pad, minus the label. */
function laneWidth(durationSec: number, pxPerSec: number): string {
  return `calc(${durationSec} * ${pxPerSec}px + ${TAPE_END_PAD_PX}px)`;
}

/* ── The shape the parent projects ────────────────────────────────────────── */

export interface TimelineTapeBeat {
  /** The beat's words. Shown on hover; never the clip's accessible name. */
  readonly text: string;
  /** From `resolveTimeline`, in `t` — this component never divides a weight. */
  readonly startT: number;
  readonly endT: number;
  /** Computed by the parent with the domain's own slack, never `1.2` here. */
  readonly underFloor: boolean;
}

export interface TimelineTapeProps {
  /** The previewed clip length: the axis every x below is measured on. */
  readonly durationSec: number;
  /** `resolveTimeline`'s windows, mapped once by the parent. */
  readonly beats: readonly TimelineTapeBeat[];
  /**
   * The SHORTEST duration the axis can draw — where the dwell floor is actually
   * evaluated (`studio-editor.md` §4.2). A beat that looks comfortable on the
   * previewed 15 s can still be under-floor on a 6 s cell, so the sentence has
   * to speak about that cell, not about the one on screen.
   */
  readonly shortestDurationSec: number;
  /** The live second: what the painted diamond follows. */
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
  /** Which host mounted it (D145 rail, D146 Copy section). Reflected, not styled. */
  readonly host: "rail" | "section";
}

/* ── Pieces ───────────────────────────────────────────────────────────────── */

/**
 * The ruler, inside the one scrollport — that is the whole point. A tick per
 * whole second, including the last one, which is the tick the sketch cropped.
 */
function Ruler({ durationSec, pxPerSec }: { durationSec: number; pxPerSec: number }): ReactNode {
  const ticks = [];
  for (let second = 0; second <= Math.floor(durationSec); second += 1) ticks.push(second);
  return (
    <div className="relative h-6" aria-hidden="true" data-tape-ruler="">
      {ticks.map((second) => (
        <span
          key={second}
          data-tape-tick={second}
          className="absolute top-0 h-full border-l border-border pl-1 font-mono text-[10px] leading-6 text-text-muted"
          style={{ left: xFor(second, pxPerSec) }}
        >
          {messages.tapeTick(second)}
        </span>
      ))}
    </div>
  );
}

/**
 * A lane: a sticky name column and a canvas the clips are absolutely placed on.
 * The label is `sticky left-0` so a sideways scroll does not take the names with
 * it — the one lesson worth keeping from the HTML sketch.
 */
function Lane({
  name,
  durationSec,
  pxPerSec,
  children,
}: {
  name: string;
  durationSec: number;
  pxPerSec: number;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="grid h-11 grid-cols-[var(--tt-label)_1fr] items-center">
      <div className="sticky left-0 z-10 flex h-full flex-col items-center justify-center gap-0.5 border-r border-border bg-background font-mono text-[9px] uppercase tracking-eyebrow text-text-muted">
        {name}
      </div>
      <div className="relative h-full" style={{ width: laneWidth(durationSec, pxPerSec) }}>
        {children}
      </div>
    </div>
  );
}

/**
 * A clip. Its accessible name is stable ("Beat 2", "Video clip") and never the
 * live seconds — those belong to the playhead slider, which is the control that
 * actually carries a value (studio §9.3). Under-floor paints AND says so: colour
 * is never the only carrier (DESIGN.md §7).
 */
function Clip(props: {
  startSec: number;
  durSec: number;
  pxPerSec: number;
  tone: "title" | "video";
  selected?: boolean;
  underFloor?: boolean;
  name: string;
  title?: string;
  describedBy?: string;
  onSelect?: () => void;
  children?: ReactNode;
}): ReactNode {
  const tones = {
    title: "bg-modified/20 text-modified border-modified/50",
    video: "bg-brand-tint text-brand-on-tint border-border",
  } as const;
  return (
    <button
      type="button"
      aria-label={props.name}
      aria-pressed={props.selected}
      aria-invalid={props.underFloor === true ? true : undefined}
      aria-describedby={props.underFloor === true ? props.describedBy : undefined}
      title={props.title}
      className={cn(
        "absolute bottom-1 top-1 overflow-hidden rounded-md border text-left transition-colors duration-fast",
        tones[props.tone],
        props.selected === true &&
          "border-brand-primary shadow-[0_0_0_2px] shadow-brand-primary/30",
        props.underFloor === true && "border-error/50 bg-error/20 text-error",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      )}
      style={{
        left: `calc(${props.startSec} * ${props.pxPerSec}px)`,
        width: `calc(${props.durSec} * ${props.pxPerSec}px)`,
      }}
      onClick={props.onSelect}
    >
      {props.children}
      <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[11px] font-semibold">
        {props.name}
      </span>
    </button>
  );
}

/**
 * The film perforation, in CSS. Never a filmstrip of remote frames: the preview
 * cell IS the compositor frame (D52/VE-D6), and a second picture of the creative
 * beside it would be a second renderer's opinion of the same second.
 */
function FilmPerforations(): ReactNode {
  const perforation =
    "linear-gradient(180deg, color-mix(in srgb, var(--color-scrim) 18%, transparent) 0 3px," +
    " transparent 3px calc(100% - 3px)," +
    " color-mix(in srgb, var(--color-scrim) 18%, transparent) calc(100% - 3px))";
  return (
    <span aria-hidden="true" className="pointer-events-none absolute inset-0 flex">
      {[0, 1, 2, 3, 4, 5].map((cell) => (
        <i
          key={cell}
          className="min-w-0 flex-1 border-r border-scrim/20"
          style={{ background: perforation }}
        />
      ))}
    </span>
  );
}

/**
 * The painted playhead: decoration with no tab stop. The accessible playhead is
 * the native range below — two sliders in the accessibility tree would announce
 * the same fact twice (DESIGN.md §4 — the lesson the header's
 * own theme control already taught).
 */
function Playhead({
  seconds,
  durationSec,
  pxPerSec,
  committedLabel,
}: {
  seconds: number;
  durationSec: number;
  pxPerSec: number;
  committedLabel: string;
}): ReactNode {
  const clamped = Math.min(durationSec, Math.max(0, seconds));
  return (
    <div
      role="presentation"
      aria-hidden="true"
      data-tape-playhead=""
      className="pointer-events-none absolute inset-y-0 z-20 -ml-2.5 w-5"
      style={{ left: xFor(clamped, pxPerSec) }}
    >
      <span className="absolute left-1/2 top-0.5 size-3 -translate-x-1/2 rotate-45 rounded-sm bg-text-emphasis" />
      <span className="absolute left-1/2 top-0 h-full w-0.5 -translate-x-1/2 bg-text-emphasis" />
      <span className="absolute left-1/2 top-4 -translate-x-1/2 whitespace-nowrap rounded-full border border-border-control bg-surface px-1.5 font-mono text-[10px] text-text-primary">
        {committedLabel}
      </span>
    </div>
  );
}

/**
 * The accessible playhead, and the reason it is a NATIVE range:
 * `use-step-navigation.ts` only hands a drag to `[role="slider"]`,
 * `input[type="range"]` or `[draggable="true"]`, so a custom-painted knob would
 * be swallowed by the guided swipe (studio §9.3 point 5).
 *
 * The handler split is the shipped one, copied from `PreviewDock` rather than
 * invented: `onChange` fires continuously through a drag and is therefore the
 * LIVE value; the commit is `onPointerUp` **and** `onKeyUp`, because a keyboard
 * user never fires a pointer event and a pointer-only commit would leave them
 * able to move the thumb and unable to move the frame.
 */
function PlayheadSlider({
  durationSec,
  scrubSec,
  onLive,
  onCommit,
}: {
  durationSec: number;
  scrubSec: number;
  onLive: (sec: number) => void;
  onCommit: (sec: number) => void;
}): ReactNode {
  return (
    <input
      type="range"
      min={0}
      max={durationSec}
      // One encoded frame, from the encoder's own constant — never a restated 30.
      step={1 / MOTION_FPS}
      value={scrubSec}
      aria-label={messages.tapePlayheadName}
      className="h-10 min-w-0 flex-1 cursor-pointer accent-brand-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      onChange={(e) => onLive(Number(e.target.value))}
      onPointerUp={(e) => onCommit(Number(e.currentTarget.value))}
      onKeyUp={(e) => onCommit(Number(e.currentTarget.value))}
    />
  );
}

/** A ±1 s nudge. A button that does a thing once — never a hold-to-repeat clock. */
function Nudge({
  name,
  onClick,
  children,
}: {
  name: string;
  onClick: () => void;
  children: ReactNode;
}): ReactNode {
  return (
    <button
      type="button"
      aria-label={name}
      onClick={onClick}
      className="h-10 shrink-0 rounded-md border border-border-control bg-surface-2 px-2 text-sm text-text-primary transition-colors duration-fast hover:border-border-control-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      {children}
    </button>
  );
}

/* ── The tape ─────────────────────────────────────────────────────────────── */

function TimelineTapeImpl(props: TimelineTapeProps): ReactNode {
  const { durationSec, beats, shortestDurationSec, scrubSec, committedSec, host } = props;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const portWidth = useInlineWidth(scrollRef);
  /**
   * D147 — zoom is ephemeral, the same bucket as selection and scrub. It is not a
   * property of the campaign, and persisting it would surprise a second operator
   * on the same brief. Default is fit; the operator may zoom in; a reload resets.
   */
  const [zoomPx, setZoomPx] = useState(TAPE_PX_MIN);
  const [zoomedByUser, setZoomedByUser] = useState(false);
  /**
   * A changed duration axis retires the operator's zoom: a 6 s → 15 s change at a
   * 6 s zoom leaves nine seconds off the right-hand edge, which is the cutoff
   * this plan exists to close, arriving by a different door.
   */
  useEffect(() => {
    setZoomedByUser(false);
  }, [durationSec]);

  const pxPerSec = zoomedByUser ? zoomPx : fitPx(portWidth, durationSec);

  /**
   * Whether a commit has landed yet, so the status can say what happened.
   *
   * It follows the committed second itself, not only this component's own commit
   * path: the rail hosts the dock's shipped scrub control beside the tape, and
   * both write the SAME lifted second (that is what CC5 is for). A flag set only
   * by the tape's own buttons would leave the sentence saying "drag the playhead
   * to scrub" while the readout under the diamond already showed the frame a
   * release on the dock's range had landed — the tape and the dock disagreeing
   * about the same draft, which is the class of defect this lane keeps closing.
   *
   * The local set stays for the case the effect cannot see: a nudge that clamps
   * to a second already committed (−1 s at 0) moves nothing, and is still the
   * operator asking for that frame.
   */
  const [committed, setCommitted] = useState(false);
  const lastCommittedSec = useRef(committedSec);
  useEffect(() => {
    if (lastCommittedSec.current === committedSec) return;
    lastCommittedSec.current = committedSec;
    setCommitted(true);
  }, [committedSec]);
  const statusId = "timeline-tape-status";

  const clamp = (sec: number) => Math.min(Math.max(0, sec), Math.max(0, durationSec));
  const commit = (sec: number) => {
    setCommitted(true);
    props.onScrubCommit(clamp(sec));
  };

  /**
   * A click on the canvas — the ruler, a lane's empty space — commits the second
   * under the pointer. It is a COMMIT and not a live move because it is
   * equivalent to dragging the thumb there and letting go.
   *
   * The handler sits on the scrollport rather than on the ruler for two reasons:
   * the element it must measure from is then the event's own `currentTarget`
   * (there is no ref to find and no null to invent a branch for), and the port is
   * the one element whose `scrollLeft` the arithmetic needs — which is what keeps
   * a click correct at any scroll position, the term the HTML sketch got wrong.
   *
   * A click that landed on a CLIP is that clip's selection, not a scrub: the
   * clips are real buttons, and swallowing their click here would make a beat
   * unselectable by mouse.
   */
  const commitFromCanvas = (e: MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button") !== null) return;
    const port = e.currentTarget;
    const rect = port.getBoundingClientRect();
    commit((e.clientX - rect.left + port.scrollLeft - TAPE_LABEL_PX) / pxPerSec);
  };

  /**
   * The first beat under the floor, evaluated where the floor actually binds —
   * the SHORTEST duration, not the previewed one. The comparison uses the
   * domain's own slack, exactly as `ProportionBar` does: `3 × 1.2` is
   * `3.5999999999999996`, so a strict comparison would paint a beat red that
   * `timelineProblem` accepts.
   */
  const breached = beats.find((beat) => beat.underFloor);
  const statusSentence =
    breached !== undefined
      ? messages.timelineDwellUnderFloor(
          (breached.endT - breached.startT) * shortestDurationSec,
          MIN_DWELL_SEC,
        )
      : committed
        ? messages.tapeCommittedStatus(formatTapeClock(committedSec))
        : messages.tapeIdleStatus;

  return (
    <div
      className="timeline-tape rounded-lg border border-border bg-background"
      data-tape-host={host}
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
        <h2 className="text-sm font-semibold text-text-emphasis">{messages.tapeLegend}</h2>
        <p className="font-mono text-[11px] uppercase tracking-eyebrow text-text-muted">
          {messages.tapePxPerSecond(pxPerSec)}
        </p>
      </div>

      {/* DESIGN.md §7: the ONE horizontal scroller on this surface. The ruler,
          both lanes and the playhead live inside it, so they share one
          `scrollLeft` by construction rather than by an effect that syncs two. */}
      <div
        ref={scrollRef}
        data-tape-scrollport=""
        className="relative overflow-x-auto overflow-y-hidden overscroll-x-contain border-y border-border"
        onClick={commitFromCanvas}
      >
        <div
          data-tape-canvas=""
          className="relative min-h-[11.75rem]"
          style={{ width: canvasWidth(durationSec, pxPerSec) }}
        >
          <Ruler durationSec={durationSec} pxPerSec={pxPerSec} />

          <Lane name={messages.tapeLaneTitle} durationSec={durationSec} pxPerSec={pxPerSec}>
            {beats.map((beat, index) => (
              <Clip
                key={index}
                startSec={beat.startT * durationSec}
                durSec={(beat.endT - beat.startT) * durationSec}
                pxPerSec={pxPerSec}
                tone="title"
                selected={props.selectedBeatIndex === index}
                underFloor={beat.underFloor}
                describedBy={statusId}
                name={messages.tapeBeatName(index + 1)}
                title={beat.text}
                onSelect={() => props.onSelectBeat(index)}
              />
            ))}
          </Lane>

          <Lane name={messages.tapeLaneVideo} durationSec={durationSec} pxPerSec={pxPerSec}>
            <Clip
              startSec={0}
              durSec={durationSec}
              pxPerSec={pxPerSec}
              tone="video"
              name={messages.tapeVideoClip}
            >
              <FilmPerforations />
            </Clip>
          </Lane>

          <Playhead
            seconds={scrubSec}
            durationSec={durationSec}
            pxPerSec={pxPerSec}
            committedLabel={formatTapeClock(committedSec)}
          />
        </div>
      </div>

      <div className="flex items-center gap-2 px-3 py-3">
        <Nudge name={messages.tapeNudgeBack} onClick={() => commit(committedSec - 1)}>
          −1s
        </Nudge>
        <PlayheadSlider
          durationSec={durationSec}
          scrubSec={scrubSec}
          onLive={props.onScrubLive}
          onCommit={commit}
        />
        <Nudge name={messages.tapeNudgeForward} onClick={() => commit(committedSec + 1)}>
          +1s
        </Nudge>
        <input
          type="range"
          min={TAPE_PX_MIN}
          max={TAPE_PX_MAX}
          step={1}
          value={pxPerSec}
          aria-label={messages.tapeZoomName}
          className="h-10 w-20 shrink-0 cursor-pointer accent-brand-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          onChange={(e) => {
            setZoomPx(Number(e.target.value));
            setZoomedByUser(true);
          }}
        />
      </div>

      <p id={statusId} role="status" className="px-3 pb-3 text-[11px] text-text-muted">
        {statusSentence}
      </p>
    </div>
  );
}

export const TimelineTape = memo(TimelineTapeImpl);

/** The floor comparison, in one place, for the parent that computes `underFloor`. */
export function beatUnderFloor(dwellSec: number): boolean {
  return dwellSec < MIN_DWELL_SEC - DWELL_TOLERANCE;
}
