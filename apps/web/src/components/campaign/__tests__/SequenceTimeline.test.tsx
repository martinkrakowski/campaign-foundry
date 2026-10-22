import { describe, test, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, fireEvent } from "@testing-library/react";
import { resolveTimeline } from "@campaignfoundry/CampaignOrchestration/copy-timeline";
import {
  MOTION_FPS,
  encodedDurationSec,
} from "@campaignfoundry/CampaignOrchestration/motion-kinds";
import * as messages from "../messages";
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

  test("the keyboard moves a beat one step, the same single call (§7)", () => {
    const onMoveBeat = vi.fn();
    renderTimeline({ onMoveBeat });
    fireEvent.keyDown(beatClip(1), { key: "ArrowRight" });
    expect(onMoveBeat).toHaveBeenCalledWith(0, 1);
    // The ends are the ends.
    onMoveBeat.mockClear();
    fireEvent.keyDown(beatClip(2), { key: "ArrowRight" });
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
});
