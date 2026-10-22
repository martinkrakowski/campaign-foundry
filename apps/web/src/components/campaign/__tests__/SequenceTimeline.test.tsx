import { describe, test, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  MIN_DWELL_SEC,
  resolveTimeline,
} from "@campaignfoundry/CampaignOrchestration/copy-timeline";
import {
  MOTION_FPS,
  encodedDurationSec,
} from "@campaignfoundry/CampaignOrchestration/motion-kinds";
import * as messages from "../messages";
import { TAPE_LABEL_PX, formatTapeClock } from "../TimelineTape";
import type { TrackDiamond } from "../track-diamonds";
import { SequenceTimeline, type SequenceTimelineProps } from "../SequenceTimeline";

/**
 * VT1's acceptance tests, as tests that can fail
 * (`2026-10-12_motion-sequence-editor.md` §8). The boundary, diamond and
 * playhead pieces are the tape's own, so their geometry is already pinned in
 * `TimelineTape.test.tsx`; what this file pins is what is NEW: the text clip's
 * drag-to-reorder, the full-duration video rows, the add-track offers, and the
 * source rules the plan restates for this component (§5: no reducer import, no
 * action named, nothing playing).
 */

const DURATION = 6;

/** Two beats, 2:1 — resolved by the compositor's own function, never divided here. */
const SOURCE_BEATS = [
  { text: "Stay wild", weight: 2 },
  { text: "Stay hydrated", weight: 1 },
] as const;
const resolved = resolveTimeline(
  {
    beats: [...SOURCE_BEATS],
    transition: "cut",
    keyBeat: 1,
  },
  DURATION,
);
const beats = resolved.map((beat, index) => ({
  text: beat.text,
  startT: beat.startT,
  endT: beat.endT,
  weight: SOURCE_BEATS[index]!.weight,
  underFloor: false,
}));

/**
 * Three equal beats, 1:1:1 — the keyboard reorder's own fixture: a second
 * arrow must still have somewhere to move the same beat to, which the two-beat
 * fixture above cannot show.
 */
const KEYBOARD_SOURCE = [
  { text: "One", weight: 1 },
  { text: "Two", weight: 1 },
  { text: "Three", weight: 1 },
] as const;
const keyboardResolved = resolveTimeline(
  {
    beats: [...KEYBOARD_SOURCE],
    transition: "cut",
    keyBeat: 1,
  },
  DURATION,
);
const keyboardBeats = keyboardResolved.map((beat, index) => ({
  text: beat.text,
  startT: beat.startT,
  endT: beat.endT,
  weight: KEYBOARD_SOURCE[index]!.weight,
  underFloor: false,
}));

/** One enabled video row and one switched-off one — VT-D7's both-halves fixture. */
const videoRows: SequenceTimelineProps["videoRows"] = [
  { id: "video", index: 0, off: false, canToggle: true, canMoveUp: false, canMoveDown: false },
  { id: "video-2", index: 4, off: true, canToggle: true, canMoveUp: true, canMoveDown: true },
];

const baseProps: SequenceTimelineProps = {
  durationSec: DURATION,
  beats,
  shortestDurationSec: DURATION,
  scrubSec: 0,
  committedSec: 0,
  selectedBeatIndex: null,
  onScrubLive: vi.fn(),
  onScrubCommit: vi.fn(),
  onSelectBeat: vi.fn(),
  onMoveBeat: vi.fn(),
  onBoundaryCommit: vi.fn(),
  videoRows,
  selectedLayerId: null,
  onSelectLayer: vi.fn(),
  onSetLayerEnabled: vi.fn(),
  onMoveLayer: vi.fn(),
  onAddVideo: vi.fn(),
  canAddText: false,
  onAddText: vi.fn(),
  host: "rail",
};

const renderTimeline = (overrides: Partial<SequenceTimelineProps> = {}) => {
  const props = { ...baseProps, ...overrides } as SequenceTimelineProps;
  for (const key of Object.keys(baseProps) as (keyof SequenceTimelineProps)[]) {
    if (typeof baseProps[key] === "function" && !Object.hasOwn(overrides, key)) {
      // Fresh spy per render, unless the caller named the prop — including
      // naming it `undefined`, which is the "this host offers nothing" case
      // and must not be papered over with a mock.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (props as any)[key] = vi.fn();
    }
  }
  return render(<SequenceTimeline {...props} />);
};

/**
 * The component's own source, for the checks that are about what is NOT in the
 * file. Read from disk rather than imported: the point is the text a reviewer
 * would grep, comments included.
 */
const SOURCE_PATH = "apps/web/src/components/campaign/SequenceTimeline.tsx";
const source = readFileSync(resolve(process.cwd(), SOURCE_PATH), "utf8");

const beatClip = (position: number) => {
  const beat = beats[position - 1]!;
  return screen.getByRole("button", {
    name: messages.sequenceBeatClip(position, beat.startT * DURATION, beat.endT * DURATION),
  });
};
/** The clip button a given beats array puts at `position`, by its own name. */
const clipNamed = (arr: typeof beats, position: number) => {
  const beat = arr[position - 1]!;
  return screen.getByRole("button", {
    name: messages.sequenceBeatClip(position, beat.startT * DURATION, beat.endT * DURATION),
  });
};
const videoClip = (position: number) =>
  screen.getByRole("button", { name: messages.sequenceVideoClip(position, DURATION) });

describe("the source rules the plan restates for this component (§5, §7, §9)", () => {
  test("the file is really the component the checks below grep", () => {
    expect(source.length).toBeGreaterThan(2000);
    expect(source).toContain("export const SequenceTimeline");
  });

  test("no reducer import and no action named — the tape's rule, inherited", () => {
    expect(source).not.toContain("editor-state");
    expect(source).not.toContain("EditorAction");
    expect(source).not.toMatch(/\bdispatch\b/);
  });

  test("nothing plays, and no literal survives a theme toggle", () => {
    expect(source).not.toMatch(/requestAnimationFrame\s*\(/);
    expect(source).not.toMatch(/setInterval\s*\(/);
    expect(source).not.toMatch(/<video\b/);
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toContain("cf:theme");
  });

  test("no play button — not a disabled one (VT-D6)", () => {
    renderTimeline();
    expect(screen.queryByRole("button", { name: /play/i })).toBeNull();
  });
});

describe("the text clip's drag-to-reorder (§4.1, §8)", () => {
  /**
   * happy-dom does no layout, so the drag's arithmetic runs against zero rects
   * and the pointer's own clientX: `fitPx(0, 6)` floors to `TAPE_PX_MIN` (28
   * px/s), beat 1 is [0, 4) s and beat 2 is [4, 6] s, and an x of 4.5 s names
   * beat 2 — the same necessary-not-sufficient stance the tape's geometry
   * tests take.
   */
  test("a drag onto another beat commits onMoveBeat exactly once, on pointerup", () => {
    const onMoveBeat = vi.fn();
    const onScrubLive = vi.fn();
    const onScrubCommit = vi.fn();
    renderTimeline({ onMoveBeat, onScrubLive, onScrubCommit });

    const clip = beatClip(1);
    fireEvent.pointerDown(clip, { clientX: 28 });
    // Two moves: the view state may follow the finger, the brief may not.
    fireEvent.pointerMove(clip, { clientX: 84 });
    fireEvent.pointerMove(clip, { clientX: 28 * 4.5 });
    expect(onMoveBeat).not.toHaveBeenCalled();
    // §8's preview-cost rule: nothing on this gesture fetches a frame.
    expect(onScrubLive).not.toHaveBeenCalled();
    expect(onScrubCommit).not.toHaveBeenCalled();

    fireEvent.pointerUp(clip);
    expect(onMoveBeat).toHaveBeenCalledTimes(1);
    expect(onMoveBeat).toHaveBeenCalledWith(0, 1);
  });

  test("a drop back on the clip's own window is not a move", () => {
    const onMoveBeat = vi.fn();
    renderTimeline({ onMoveBeat });
    const clip = beatClip(1);
    fireEvent.pointerDown(clip, { clientX: 28 });
    fireEvent.pointerMove(clip, { clientX: 56 });
    fireEvent.pointerUp(clip);
    expect(onMoveBeat).not.toHaveBeenCalled();
  });

  test("the clips carry touch-none, so a touch drag is not the scrollport's scroll", () => {
    renderTimeline();
    // A scrollport takeover ends the pointer pair in `pointercancel`, not
    // `pointerup` — the class is what keeps a touch drag the clip's own.
    expect(beatClip(1).className).toContain("touch-none");
  });

  test("a pointercancel aborts the drag: no move, and the drag paint clears", () => {
    const onMoveBeat = vi.fn();
    renderTimeline({ onMoveBeat });
    const clip = beatClip(1);
    fireEvent.pointerDown(clip, { clientX: 28 });
    fireEvent.pointerMove(clip, { clientX: 28 * 4.5 });
    // The source clip shows the drag while the gesture is live...
    expect(clip.className).toContain("opacity-60");
    // ...and the takeover is the gesture's END: no write — the cancel is not
    // a release — and nothing painted either.
    fireEvent.pointerCancel(clip);
    expect(onMoveBeat).not.toHaveBeenCalled();
    expect(clip.className).not.toContain("opacity-60");
  });

  test("a click that never moved selects the beat; a drag's trailing click does not", () => {
    const onSelectBeat = vi.fn();
    renderTimeline({ onSelectBeat });

    fireEvent.pointerDown(beatClip(1), { clientX: 28 });
    fireEvent.pointerUp(beatClip(1));
    fireEvent.click(beatClip(1));
    expect(onSelectBeat).toHaveBeenCalledWith(0);

    onSelectBeat.mockClear();
    fireEvent.pointerDown(beatClip(1), { clientX: 28 });
    fireEvent.pointerMove(beatClip(1), { clientX: 28 * 4.5 });
    fireEvent.pointerUp(beatClip(1));
    fireEvent.click(beatClip(1));
    expect(onSelectBeat).not.toHaveBeenCalled();
  });

  test("a 1 px wobble is a click: the beat selects, and nothing moves", () => {
    const onSelectBeat = vi.fn();
    const onMoveBeat = vi.fn();
    renderTimeline({ onSelectBeat, onMoveBeat });
    fireEvent.pointerDown(beatClip(1), { clientX: 28 });
    // 29 px is still beat 1's window [0, 4) s at the fit floor: the pointer
    // wobbled, it never reached a different beat — so the gesture is not a
    // drag, and the trailing click must still be the selection it always was.
    fireEvent.pointerMove(beatClip(1), { clientX: 29 });
    fireEvent.pointerUp(beatClip(1));
    fireEvent.click(beatClip(1));
    expect(onSelectBeat).toHaveBeenCalledWith(0);
    expect(onMoveBeat).not.toHaveBeenCalled();
  });

  test("the keyboard moves a beat one step, the same single call (§7)", () => {
    const onMoveBeat = vi.fn();
    renderTimeline({ onMoveBeat });
    fireEvent.keyDown(beatClip(1), { key: "ArrowRight" });
    expect(onMoveBeat).toHaveBeenCalledWith(0, 1);
    // The ends are the ends.
    onMoveBeat.mockClear();
    fireEvent.keyDown(beatClip(2), { key: "ArrowRight" });
    expect(onMoveBeat).not.toHaveBeenCalled();
    // The same single call, one step the other way — and the ends again.
    onMoveBeat.mockClear();
    fireEvent.keyDown(beatClip(2), { key: "ArrowLeft" });
    expect(onMoveBeat).toHaveBeenCalledWith(1, 0);
    onMoveBeat.mockClear();
    fireEvent.keyDown(beatClip(1), { key: "ArrowLeft" });
    expect(onMoveBeat).not.toHaveBeenCalled();
  });

  test("two ArrowRight presses walk a beat two steps, focus following it (§7)", () => {
    const onMoveBeat = vi.fn();
    // The rerender needs one props object across both presses, so this test
    // renders directly rather than through the fresh-spy helper.
    const props = { ...baseProps, beats: keyboardBeats, onMoveBeat } as SequenceTimelineProps;
    const view = render(<SequenceTimeline {...props} />);

    // The operator's own focus, the way the gesture really starts.
    const first = clipNamed(keyboardBeats, 1);
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(onMoveBeat).toHaveBeenCalledTimes(1);
    expect(onMoveBeat).toHaveBeenLastCalledWith(0, 1);

    // The parent lands the move: the beats re-arrive with the beat at 1.
    const movedOnce = [keyboardBeats[1]!, keyboardBeats[0]!, keyboardBeats[2]!];
    view.rerender(<SequenceTimeline {...props} beats={movedOnce} />);

    // Focus followed the BEAT, not the slot — the clips are keyed by index,
    // so the slot that was pressed now carries the neighbour, and a second
    // press there would move the wrong beat.
    expect(document.activeElement).toBe(clipNamed(movedOnce, 2));

    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(onMoveBeat).toHaveBeenCalledTimes(2);
    expect(onMoveBeat).toHaveBeenLastCalledWith(1, 2);
  });

  test("a refused keyboard move never steers focus on a later, unrelated beats change", () => {
    const props = {
      ...baseProps,
      beats: keyboardBeats,
      onMoveBeat: vi.fn(),
    } as SequenceTimelineProps;
    const view = render(<SequenceTimeline {...props} />);
    const pressed = clipNamed(keyboardBeats, 1);
    pressed.focus();
    // The parent refuses the move: nothing re-renders (the component is memoised).
    fireEvent.keyDown(pressed, { key: "ArrowRight" });

    // Later an unrelated edit delivers a new beats array in the SAME order. An
    // armed target would pull focus to the neighbour at index 1.
    view.rerender(<SequenceTimeline {...props} beats={[...keyboardBeats]} />);
    expect(document.activeElement).toBe(pressed);

    // The press was disarmed by that change: a later reorder does not revive it.
    const swapped = [keyboardBeats[1]!, keyboardBeats[0]!, keyboardBeats[2]!];
    view.rerender(<SequenceTimeline {...props} beats={swapped} />);
    expect(document.activeElement).toBe(clipNamed(swapped, 1));
  });

  test("a refused keyboard move followed by a shorter list focuses nothing and throws nothing", () => {
    const props = {
      ...baseProps,
      beats: keyboardBeats,
      onMoveBeat: vi.fn(),
    } as SequenceTimelineProps;
    const view = render(<SequenceTimeline {...props} />);
    const pressed = clipNamed(keyboardBeats, 2);
    pressed.focus();
    fireEvent.keyDown(pressed, { key: "ArrowRight" });
    // A delete lands instead: two beats, so the armed target (index 2) is past
    // the end of the list.
    const shorter = [keyboardBeats[0]!, keyboardBeats[1]!];
    expect(() => view.rerender(<SequenceTimeline {...props} beats={shorter} />)).not.toThrow();
    // Focus stays on the slot the operator pressed (clips are keyed by index).
    expect(document.activeElement).toBe(clipNamed(shorter, 2));
  });

  test("auto-repeat is not a run of moves: a held key's repeats call nothing", () => {
    const onMoveBeat = vi.fn();
    renderTimeline({ beats: keyboardBeats, onMoveBeat });
    fireEvent.keyDown(clipNamed(keyboardBeats, 1), { key: "ArrowRight", repeat: true });
    expect(onMoveBeat).not.toHaveBeenCalled();
  });

  test("a held arrow's repeat is prevented, so the scrollport never scrolls (§7)", () => {
    const onMoveBeat = vi.fn();
    renderTimeline({ beats: keyboardBeats, onMoveBeat });
    // `fireEvent` returns false when the keydown's default was prevented — which
    // is the whole point: before this fix a repeated arrow was ignored but never
    // prevented, so the held key scrolled the timeline's scrollport.
    expect(
      fireEvent.keyDown(clipNamed(keyboardBeats, 1), { key: "ArrowRight", repeat: true }),
    ).toBe(false);
    expect(onMoveBeat).not.toHaveBeenCalled();
  });

  test("a non-arrow keydown on a clip is left alone", () => {
    const onMoveBeat = vi.fn();
    renderTimeline({ beats: keyboardBeats, onMoveBeat });
    // Not an arrow: not prevented (the event still propagates) and no move.
    expect(fireEvent.keyDown(clipNamed(keyboardBeats, 1), { key: "Enter" })).toBe(true);
    expect(onMoveBeat).not.toHaveBeenCalled();
  });

  test("a drag past the end drops on the last beat, never past it", () => {
    const onMoveBeat = vi.fn();
    renderTimeline({ onMoveBeat });
    const clip = beatClip(1);
    fireEvent.pointerDown(clip, { clientX: 28 });
    // 200 px is 7.1 s on the fit floor — beyond the 6 s canvas, so the drop
    // clamps to the last beat rather than naming an index that is not there.
    fireEvent.pointerMove(clip, { clientX: 200 });
    fireEvent.pointerUp(clip);
    expect(onMoveBeat).toHaveBeenCalledTimes(1);
    expect(onMoveBeat).toHaveBeenCalledWith(0, 1);
  });

  test("a pointermove with no drag in flight commits nothing", () => {
    const onMoveBeat = vi.fn();
    renderTimeline({ onMoveBeat });
    // A stray move (no pointerdown on a clip first) is not a gesture: the
    // in-flight ref is the authority, not the pointer's mere presence.
    fireEvent.pointerMove(beatClip(1), { clientX: 84 });
    expect(onMoveBeat).not.toHaveBeenCalled();
  });
});

describe("the boundary handles (TL3, restated for this surface)", () => {
  const handle = () => screen.getByRole("slider", { name: messages.tapeBeatBoundaryName(1) });

  test("a drag commits exactly once, on release, as a neighbour-transfer delta", () => {
    const onBoundaryCommit = vi.fn();
    renderTimeline({ onBoundaryCommit });
    const el = handle();
    // Weights 2:1, so the pair is 3: min 1, max 2. One step to the LEFT is a
    // real neighbour transfer; a step to the right would be a zero delta.
    fireEvent.change(el, { target: { value: "2" } });
    fireEvent.change(el, { target: { value: "1" } });
    expect(onBoundaryCommit).not.toHaveBeenCalled();
    fireEvent.pointerUp(el);
    expect(onBoundaryCommit).toHaveBeenCalledTimes(1);
    expect(onBoundaryCommit).toHaveBeenCalledWith(0, -1);
  });

  test("a one-beat sequence has no join, so no handle", () => {
    const onBoundaryCommit = vi.fn();
    renderTimeline({
      beats: [{ text: "Only", startT: 0, endT: 1, weight: 1, underFloor: false }],
      onBoundaryCommit,
    });
    expect(screen.queryByRole("slider", { name: messages.tapeBeatBoundaryName(1) })).toBeNull();
  });
});

describe("the transport: the scrub's commits and the zoom (TS1's rules, this surface)", () => {
  test("the nudges commit one clamped second each, and the status names the frame", () => {
    const onScrubCommit = vi.fn();
    renderTimeline({ onScrubCommit });

    fireEvent.click(screen.getByRole("button", { name: messages.tapeNudgeBack }));
    // −1 s at 0 clamps to 0: still the operator asking for that frame.
    expect(onScrubCommit).toHaveBeenCalledTimes(1);
    expect(onScrubCommit).toHaveBeenCalledWith(0);
    fireEvent.click(screen.getByRole("button", { name: messages.tapeNudgeForward }));
    expect(onScrubCommit).toHaveBeenLastCalledWith(1);

    // The local commit flag: the status says a frame landed, not the idle
    // sentence — the second it names is still the committed prop's.
    expect(screen.getByText(messages.tapeCommittedStatus(formatTapeClock(0)))).toBeTruthy();
    expect(screen.queryByText(messages.tapeIdleStatus)).toBeNull();
  });

  test("a click on the canvas commits the second under the pointer; a control's click is not a scrub", () => {
    const onScrubCommit = vi.fn();
    renderTimeline({ onScrubCommit });
    const port = document.querySelector("[data-sequence-scrollport]");
    expect(port).toBeTruthy();
    // happy-dom lays nothing out: the port's rect and scrollLeft read 0 and the
    // fit floor is 28 px/s, so clientX is the only live term in the arithmetic.
    fireEvent.click(port!, { clientX: TAPE_LABEL_PX + 2 * 28 });
    expect(onScrubCommit).toHaveBeenLastCalledWith(2);
    // Left of the label column clamps to the start of the clip.
    fireEvent.click(port!, { clientX: 0 });
    expect(onScrubCommit).toHaveBeenLastCalledWith(0);
    // Past the end clamps to the end.
    fireEvent.click(port!, { clientX: TAPE_LABEL_PX + 7 * 28 });
    expect(onScrubCommit).toHaveBeenLastCalledWith(6);

    // The guard: a click that landed on a control belongs to the control — a
    // clip's click selects, it never also scrubs.
    fireEvent.click(beatClip(1));
    expect(onScrubCommit).toHaveBeenCalledTimes(3);
  });

  test("the zoom slider takes the scale from the operator, and every lane follows", () => {
    renderTimeline();
    // The fit floor before any zoom.
    expect(screen.getByText(messages.tapePxPerSecond(28))).toBeTruthy();
    fireEvent.change(screen.getByLabelText(messages.tapeZoomName), {
      target: { value: "60" },
    });
    expect(screen.getByText(messages.tapePxPerSecond(60))).toBeTruthy();
    // The clips re-scale with it: a full-duration row is 6 s at the new scale.
    expect(videoClip(1).style.width).toBe("360px");
  });

  test("a committed second from the parent moves the status off the idle sentence", () => {
    const onScrubLive = vi.fn();
    const onScrubCommit = vi.fn();
    // The rerender needs one props object across both commits, so this test
    // renders directly rather than through the fresh-spy helper.
    const props = { ...baseProps, onScrubLive, onScrubCommit } as SequenceTimelineProps;
    const view = render(<SequenceTimeline {...props} committedSec={0} />);
    expect(screen.getByText(messages.tapeIdleStatus)).toBeTruthy();

    // The parent landed a new committed second (the owner's half of the
    // live/commit split): the status follows it, and nothing was written here.
    view.rerender(<SequenceTimeline {...props} committedSec={2.5} />);
    expect(screen.getByText(messages.tapeCommittedStatus(formatTapeClock(2.5)))).toBeTruthy();
    expect(onScrubCommit).not.toHaveBeenCalled();
    expect(onScrubLive).not.toHaveBeenCalled();
  });
});

describe("the dwell floor, painted and said (D3, on this surface)", () => {
  /**
   * Weights 1:4 on the 6 s clip: beat 1 dwells 1.2 s — under the floor — and
   * beat 2 dwells 4.8 s. The parent computes `underFloor`; this surface trusts
   * it, the same trust the tape's beats carry.
   */
  const FLOOR_SOURCE = [
    { text: "Stay wild", weight: 1 },
    { text: "Stay hydrated", weight: 4 },
  ] as const;
  const floorResolved = resolveTimeline(
    {
      beats: [...FLOOR_SOURCE],
      transition: "cut",
      keyBeat: 1,
    },
    DURATION,
  );
  const floorBeats = (underFirst: boolean) =>
    floorResolved.map((beat, index) => ({
      text: beat.text,
      startT: beat.startT,
      endT: beat.endT,
      weight: FLOOR_SOURCE[index]!.weight,
      underFloor: index === (underFirst ? 0 : 1),
    }));
  const floorDwell = (position: number): string => {
    const beat = floorResolved[position - 1]!;
    return messages.timelineDwellUnderFloor((beat.endT - beat.startT) * DURATION, MIN_DWELL_SEC);
  };
  const floorClip = (position: number) => {
    const beat = floorResolved[position - 1]!;
    return screen.getByRole("button", {
      name: messages.sequenceBeatClip(position, beat.startT * DURATION, beat.endT * DURATION),
    });
  };
  const describedByText = (el: Element): string =>
    document.getElementById(el.getAttribute("aria-describedby") ?? "")?.textContent ?? "";

  test("the first breach owns the status, and the breaching clip carries its own dwell", () => {
    renderTimeline({ beats: floorBeats(true), selectedBeatIndex: 0 });

    // The status names the FIRST breach (D3), never the idle sentence.
    expect(document.getElementById("sequence-timeline-status")?.textContent).toBe(floorDwell(1));
    expect(screen.queryByText(messages.tapeIdleStatus)).toBeNull();

    const clip = floorClip(1);
    expect(clip.getAttribute("aria-invalid")).toBe("true");
    expect(describedByText(clip)).toBe(floorDwell(1));
    // Painted, not only said — and the selection ring coexists with the
    // breach: the error tone owns the border, the ring stays the pick's.
    expect(clip.className).toContain("bg-error/20");
    expect(clip.className).toContain("shadow-brand-primary/30");

    // The clean beat says and paints none of it.
    const clean = floorClip(2);
    expect(clean.getAttribute("aria-invalid")).toBeNull();
    expect(clean.className).not.toContain("bg-error/20");
  });

  test("a boundary handle carries the LEFT beat's dwell when that is the side under the floor", () => {
    renderTimeline({ beats: floorBeats(true) });
    const handle = screen.getByRole("slider", { name: messages.tapeBeatBoundaryName(1) });
    expect(handle.getAttribute("aria-invalid")).toBe("true");
    expect(describedByText(handle)).toBe(floorDwell(1));
  });

  test("a boundary handle carries the RIGHT beat's dwell when that is the side under the floor", () => {
    renderTimeline({ beats: floorBeats(false) });
    const handle = screen.getByRole("slider", { name: messages.tapeBeatBoundaryName(1) });
    expect(handle.getAttribute("aria-invalid")).toBe("true");
    // The left beat is clean, so the sentence the handle carries is the one a
    // drag would create on the right — the neighbour it would put under.
    expect(describedByText(handle)).toBe(floorDwell(2));
  });
});

describe("the video rows (VT-D2, VT-D7)", () => {
  test("every video layer is a full-duration clip, disabled ones included", () => {
    renderTimeline();
    const enabled = videoClip(1);
    const off = videoClip(2);
    // Not resizable means the width is the whole clip and there is no handle.
    expect(enabled.style.width).toBe("168px");
    expect(off.style.width).toBe("168px");
    expect(off.className).toContain("opacity-40");
  });

  test("dragging a video clip horizontally changes nothing (§7: no span to write)", () => {
    const onMoveBeat = vi.fn();
    const onMoveLayer = vi.fn();
    const onScrubLive = vi.fn();
    const onScrubCommit = vi.fn();
    renderTimeline({ onMoveBeat, onMoveLayer, onScrubLive, onScrubCommit });
    const clip = videoClip(1);
    fireEvent.pointerDown(clip, { clientX: 0 });
    fireEvent.pointerMove(clip, { clientX: 200 });
    fireEvent.pointerUp(clip);
    expect(onMoveBeat).not.toHaveBeenCalled();
    expect(onMoveLayer).not.toHaveBeenCalled();
    expect(onScrubLive).not.toHaveBeenCalled();
    expect(onScrubCommit).not.toHaveBeenCalled();
  });

  test("hide calls onSetLayerEnabled, and a disabled row still offers enable", () => {
    const onSetLayerEnabled = vi.fn();
    renderTimeline({ onSetLayerEnabled });
    fireEvent.click(screen.getByRole("button", { name: messages.sequenceHideVideoTrack(1) }));
    expect(onSetLayerEnabled).toHaveBeenCalledWith("video", false);
    // The disabled row stays on the timeline (VT-D7) and offers its way back.
    expect(videoClip(2)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: messages.sequenceShowVideoTrack(2) }));
    expect(onSetLayerEnabled).toHaveBeenCalledWith("video-2", true);
  });

  test("the last enabled video row offers no hide at all, not a refused one", () => {
    renderTimeline({
      videoRows: [
        {
          id: "video",
          index: 0,
          off: false,
          canToggle: false,
          canMoveUp: false,
          canMoveDown: false,
        },
      ],
    });
    expect(screen.queryByRole("button", { name: messages.sequenceHideVideoTrack(1) })).toBeNull();
  });

  test("a row without a layer pick is a plain box, not a tab stop", () => {
    renderTimeline({ onSelectLayer: undefined, selectedLayerId: undefined });
    expect(
      screen.queryByRole("button", { name: messages.sequenceVideoClip(1, DURATION) }),
    ).toBeNull();
    expect(document.querySelector('[data-sequence-clip="video"]')).toBeTruthy();
  });

  test("reorder in the header is stack order, via the row's own layer index", () => {
    const onMoveLayer = vi.fn();
    renderTimeline({ onMoveLayer });
    fireEvent.click(screen.getByRole("button", { name: messages.sequenceMoveVideoTrackUp(2) }));
    expect(onMoveLayer).toHaveBeenCalledWith(4, 5);
    fireEvent.click(screen.getByRole("button", { name: messages.sequenceMoveVideoTrackDown(2) }));
    expect(onMoveLayer).toHaveBeenCalledWith(4, 3);
  });

  test("picking a video row is the layer pick, and it selects", () => {
    const onSelectLayer = vi.fn();
    renderTimeline({ onSelectLayer });
    fireEvent.click(videoClip(1));
    expect(onSelectLayer).toHaveBeenCalledWith("video");
  });
});

describe("add-track (VT-D4, §4.1)", () => {
  test("add video calls its callback", () => {
    const onAddVideo = vi.fn();
    renderTimeline({ onAddVideo });
    fireEvent.click(screen.getByRole("button", { name: messages.sequenceAddVideoTrack }));
    expect(onAddVideo).toHaveBeenCalledTimes(1);
  });

  test("add text is disabled once an animated-text layer exists, and says why", () => {
    const onAddText = vi.fn();
    renderTimeline({ canAddText: false, onAddText });
    const control = screen.getByRole("button", {
      name: messages.sequenceAddTextTrack,
    }) as HTMLButtonElement;
    expect(control.disabled).toBe(true);
    fireEvent.click(control);
    expect(onAddText).not.toHaveBeenCalled();
    // The reason is said twice — on the control (sr-only) and beside it — so
    // assert presence, not uniqueness.
    expect(screen.getAllByText(messages.sequenceAddTextBlocked).length).toBeGreaterThan(0);
  });

  test("add text acts while the budget allows", () => {
    const onAddText = vi.fn();
    renderTimeline({ canAddText: true, onAddText });
    fireEvent.click(screen.getByRole("button", { name: messages.sequenceAddTextTrack }));
    expect(onAddText).toHaveBeenCalledTimes(1);
  });
});

describe("the music bed (VT-D5) and the note (§10 question 2)", () => {
  test("the row reads the path and commits nothing", () => {
    const onScrubCommit = vi.fn();
    renderTimeline({ audioPath: "assets/audio/bed-01.mp3", onScrubCommit });
    expect(screen.getByText(messages.tapeLaneAudio)).toBeTruthy();
    expect(
      screen.getByText(messages.tapeAudioSpan(DURATION, encodedDurationSec(DURATION, MOTION_FPS))),
    ).toBeTruthy();
    // The note that says the clip cannot be trimmed.
    expect(screen.getByText(messages.sequenceFullSpanNote)).toBeTruthy();
  });

  test("no bed, no row — an empty waveform would imply one the brief does not carry", () => {
    renderTimeline({ audioPath: undefined });
    expect(screen.queryByText(messages.tapeLaneAudio)).toBeNull();
  });
});

describe("the diamonds stay (VT-D8)", () => {
  const diamond: TrackDiamond = {
    trackIndex: 0,
    stopIndex: 0,
    property: "opacity",
    t: 0.5,
    sec: 3,
  };

  test("a dragged key commits once, on release", () => {
    const onDiamondCommit = vi.fn();
    renderTimeline({
      selectedLayerId: "video",
      diamonds: { placed: [diamond], unplaceable: { count: 0 } },
      onDiamondCommit,
    });
    const el = screen.getByRole("slider", {
      name: messages.tapeDiamondName(messages.TRACK_PROPERTY_LABEL.opacity, diamond.stopIndex),
    });
    fireEvent.change(el, { target: { value: "2" } });
    expect(onDiamondCommit).not.toHaveBeenCalled();
    fireEvent.pointerUp(el);
    expect(onDiamondCommit).toHaveBeenCalledTimes(1);
    expect(onDiamondCommit).toHaveBeenCalledWith(0, 0, 2);
  });

  test("no diamonds prop, no keys lane — never an empty one", () => {
    renderTimeline();
    expect(screen.queryByText(messages.tapeLaneKeyframes)).toBeNull();
  });

  test("keys that cannot be placed are counted and said, not silently dropped", () => {
    renderTimeline({
      selectedLayerId: "video",
      diamonds: { placed: [], unplaceable: { count: 2 } },
    });
    // The lane mounts for keys the ruler cannot place, exactly as it does for
    // placed ones — an empty waveform would imply the layer has no keys at all.
    expect(screen.getByText(messages.tapeLaneKeyframes)).toBeTruthy();
    expect(screen.getByText(messages.tapeKeysNotPlaced(2))).toBeTruthy();
  });
});
