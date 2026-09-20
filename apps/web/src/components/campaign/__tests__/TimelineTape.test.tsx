import { describe, test, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useState, type ReactNode } from "react";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { resolveTimeline } from "@campaignfoundry/CampaignOrchestration/copy-timeline";
import { MOTION_FPS } from "@campaignfoundry/CampaignOrchestration/motion-kinds";
import * as messages from "../messages";
import type { TrackDiamond } from "../track-diamonds";
import {
  TimelineTape,
  beatUnderFloor,
  fitPx,
  formatTapeClock,
  TAPE_END_PAD_PX,
  TAPE_LABEL_PX,
  TAPE_PX_FIT_MAX,
  TAPE_PX_MAX,
  TAPE_PX_MIN,
  type TimelineTapeBeat,
  type TimelineTapeProps,
} from "../TimelineTape";

/**
 * TS1's acceptance, as tests that can fail (`2026-09-16_rail-timeline-surface.md`
 * §4 and §8). happy-dom does no layout (DESIGN.md §8), so the geometry half is
 * asserted on the `calc(...)` STRINGS the component writes — necessary, and
 * explicitly not sufficient: the pixel clearance of the end pad is a browser
 * check recorded in the PR, not a Vitest assertion (§11).
 */

const DURATION = 6;

/** Two beats, 2:1 — resolved by the compositor's own function, never divided here. */
const resolved = resolveTimeline(
  {
    beats: [
      { text: "Stay wild", weight: 2 },
      { text: "Stay hydrated", weight: 1 },
    ],
    transition: "cut",
    keyBeat: 1,
  },
  DURATION,
);

const beats: readonly TimelineTapeBeat[] = resolved.map((beat) => ({
  text: beat.text,
  startT: beat.startT,
  endT: beat.endT,
  underFloor: false,
}));

const baseProps: TimelineTapeProps = {
  durationSec: DURATION,
  beats,
  shortestDurationSec: DURATION,
  scrubSec: 0,
  committedSec: 0,
  selectedBeatIndex: null,
  onScrubLive: () => {},
  onScrubCommit: () => {},
  onSelectBeat: () => {},
  host: "rail",
};

const renderTape = (overrides: Partial<TimelineTapeProps> = {}) =>
  render(<TimelineTape {...baseProps} {...overrides} />);

/**
 * The tape with the seconds wired the way its one owner wires them, so a test can
 * drive the real live/commit split rather than a fixture of it.
 */
function Driven({
  onCommit,
  ...overrides
}: Partial<TimelineTapeProps> & { onCommit?: (sec: number) => void }): ReactNode {
  const [scrubSec, setScrubSec] = useState(0);
  const [committedSec, setCommittedSec] = useState(0);
  return (
    <TimelineTape
      {...baseProps}
      {...overrides}
      scrubSec={scrubSec}
      committedSec={committedSec}
      onScrubLive={setScrubSec}
      onScrubCommit={(sec) => {
        setScrubSec(sec);
        setCommittedSec(sec);
        onCommit?.(sec);
      }}
    />
  );
}

/**
 * The tape's own source, for the checks that are about what is NOT in the file.
 * Read from disk rather than imported: the point of (c) and (d) is the text a
 * reviewer would grep, including comments and class strings a bundler folds away.
 */
const TAPE_PATH = "apps/web/src/components/campaign/TimelineTape.tsx";
const source = readFileSync(resolve(process.cwd(), TAPE_PATH), "utf8");

const port = () => document.querySelector("[data-tape-scrollport]") as HTMLElement;
const canvas = () => document.querySelector("[data-tape-canvas]") as HTMLElement;
const ticks = () => [...document.querySelectorAll("[data-tape-tick]")] as HTMLElement[];
const playhead = () => document.querySelector("[data-tape-playhead]") as HTMLElement;
const playheadSlider = () => screen.getByLabelText(messages.tapePlayheadName) as HTMLInputElement;
/** The video clip: a static box, so it is found by its own mark, not by a role. */
const videoClip = () => document.querySelector('[data-tape-clip="video"]') as HTMLElement;

/**
 * The number a `calc(a + b * cpx + d)` string denotes.
 *
 * Proof (a) is a RELATIONSHIP — the canvas is wider than the last thing drawn on
 * it, by the end pad — and three independently hard-coded strings do not state a
 * relationship, they state three strings. happy-dom lays nothing out, so the
 * relationship cannot be read off `scrollWidth`; it CAN be computed from what the
 * component itself wrote, which is what this does.
 */
const px = (calc: string): number => {
  const inner = calc
    .trim()
    .replace(/^calc\(/, "")
    .replace(/\)$/, "");
  let total = 0;
  for (const term of inner.split("+")) {
    const t = term.trim();
    const product = /^([\d.]+)\s*\*\s*([\d.]+)px$/.exec(t);
    if (product !== null) {
      total += Number(product[1]) * Number(product[2]);
      continue;
    }
    const plain = /^([\d.]+)px$/.exec(t);
    if (plain === null) throw new Error(`px(): cannot read term ${JSON.stringify(t)}`);
    total += Number(plain[1]);
  }
  return total;
};

describe("(a) one scrollport, one coordinate system, and an end pad", () => {
  test("the canvas is label + duration × pxPerSec + endPad wide", () => {
    renderTape();
    // happy-dom never lays out, so `fitPx` answers with its minimum — which is
    // also the number every string below must agree with.
    expect(canvas().style.width).toBe(
      `calc(${TAPE_LABEL_PX}px + ${DURATION} * ${TAPE_PX_MIN}px + ${TAPE_END_PAD_PX}px)`,
    );
    const root = canvas().closest("[data-tape-host]") as HTMLElement;
    expect(root.style.getPropertyValue("--tt-label")).toBe(`${TAPE_LABEL_PX}px`);
    expect(root.style.getPropertyValue("--tt-end-pad")).toBe(`${TAPE_END_PAD_PX}px`);
    expect(root.style.getPropertyValue("--tt-px")).toBe(String(TAPE_PX_MIN));
    expect(root.style.getPropertyValue("--tt-duration")).toBe(String(DURATION));
  });

  test("the last tick, the video clip's right edge and the playhead at t = durationSec all land on the same x", () => {
    renderTape({ scrubSec: DURATION });
    const end = `calc(${TAPE_LABEL_PX}px + ${DURATION} * ${TAPE_PX_MIN}px)`;

    // The tick the sketch cropped: there IS one at the final second.
    const last = ticks()[ticks().length - 1];
    expect(last.dataset.tapeTick).toBe(String(DURATION));
    expect(last.style.left).toBe(end);

    // The video clip spans 0…durationSec, so its right edge is that same x.
    const video = videoClip();
    expect(video.style.left).toBe(`calc(0 * ${TAPE_PX_MIN}px)`);
    expect(video.style.width).toBe(`calc(${DURATION} * ${TAPE_PX_MIN}px)`);

    expect(playhead().style.left).toBe(end);

    // …and the canvas is wider than all three by exactly the end pad, which is
    // why the last second is not cropped by the well's radius.
    expect(canvas().style.width).toBe(`${end.slice(0, -1)} + ${TAPE_END_PAD_PX}px)`);
  });

  test("the canvas is WIDER than the last thing drawn on it, by exactly the end pad", () => {
    /**
     * Proof (a) is a RELATIONSHIP, and three independently hard-coded strings
     * state three strings rather than a relationship. happy-dom lays nothing
     * out, so it cannot be read off `scrollWidth` — but it CAN be computed from
     * what the component itself wrote, which is what this does. This is the
     * assertion that goes red if `xFor` and `canvasWidth` ever drift apart while
     * each stays individually well-formed; the string tests above would not.
     */
    renderTape({ scrubSec: DURATION });
    const canvasW = px(canvas().style.width);
    const lastTickX = px(ticks()[ticks().length - 1].style.left);
    const playheadX = px(playhead().style.left);
    const videoRight = px(videoClip().style.left) + px(videoClip().style.width) + TAPE_LABEL_PX;

    // Everything at t = durationSec lands on one x …
    expect(lastTickX).toBe(playheadX);
    expect(videoRight).toBe(playheadX);
    // … and the canvas extends past it by the end pad, which is the clearance
    // the playhead's knob and the last tick's label need not to be cropped.
    expect(canvasW - playheadX).toBe(TAPE_END_PAD_PX);
    expect(canvasW).toBeGreaterThan(playheadX);

    // Still true after a zoom, which is when a fixed-pad assumption would break.
    fireEvent.change(screen.getByLabelText(messages.tapeZoomName), { target: { value: "70" } });
    expect(px(canvas().style.width) - px(playhead().style.left)).toBe(TAPE_END_PAD_PX);
    expect(px(ticks()[ticks().length - 1].style.left)).toBe(px(playhead().style.left));
  });

  test("there is exactly ONE horizontal scroller, and the ruler is inside it", () => {
    // The sketch's fourth defect: a ruler in its own `overflow-hidden` wrapper
    // does not share a `scrollLeft` with the clips, and the two drift apart.
    const { container } = renderTape();
    const scrollers = container.querySelectorAll(
      ".overflow-x-auto, .overflow-x-scroll, .overflow-auto, .overflow-scroll",
    );
    expect(scrollers.length).toBe(1);
    expect(scrollers[0]).toBe(port());
    expect(port().contains(document.querySelector("[data-tape-ruler]"))).toBe(true);
    expect(port().contains(playhead())).toBe(true);
    expect(port().contains(screen.getByRole("button", { name: messages.tapeBeatName(1) }))).toBe(
      true,
    );
  });

  test("clip widths come from resolveTimeline's windows, not from a weight divided here", () => {
    renderTape();
    const first = screen.getByRole("button", { name: messages.tapeBeatName(1) });
    const second = screen.getByRole("button", { name: messages.tapeBeatName(2) });
    // 2:1 over 6 s → 4 s and 2 s, expressed through the resolved windows so a
    // change to how the domain derives a window moves both surfaces at once.
    expect(first.style.left).toBe(`calc(${resolved[0].startT * DURATION} * ${TAPE_PX_MIN}px)`);
    expect(first.style.width).toBe(
      `calc(${(resolved[0].endT - resolved[0].startT) * DURATION} * ${TAPE_PX_MIN}px)`,
    );
    expect(second.style.left).toBe(`calc(${resolved[1].startT * DURATION} * ${TAPE_PX_MIN}px)`);
    expect(second.style.width).toBe(
      `calc(${(resolved[1].endT - resolved[1].startT) * DURATION} * ${TAPE_PX_MIN}px)`,
    );
  });
});

describe("(b) the live / committed split, on the tape's own control", () => {
  test("onChange moves the LIVE second and nothing else; the release commits", () => {
    const live: number[] = [];
    const committed: number[] = [];
    render(
      <TimelineTape
        {...baseProps}
        onScrubLive={(sec) => live.push(sec)}
        onScrubCommit={(sec) => committed.push(sec)}
      />,
    );
    fireEvent.change(playheadSlider(), { target: { value: "2" } });
    fireEvent.change(playheadSlider(), { target: { value: "3" } });
    expect(live).toEqual([2, 3]);
    expect(committed).toEqual([]);

    fireEvent.pointerUp(playheadSlider(), { target: { value: "3" } });
    expect(committed).toEqual([3]);
  });

  test("a key-up commits too — onPointerUp never fires for an arrow key", () => {
    const committed: number[] = [];
    // Driven through the owner's own state, so the thumb really holds the value
    // an arrow key left it at; no pointer event is dispatched anywhere here.
    render(<Driven onCommit={(sec) => committed.push(sec)} />);
    fireEvent.change(playheadSlider(), { target: { value: "4" } });
    expect(committed).toEqual([]);
    fireEvent.keyUp(playheadSlider(), { key: "ArrowRight" });
    expect(committed).toEqual([4]);
  });

  test("the painted diamond follows the LIVE second and the readout the COMMITTED one", () => {
    renderTape({ scrubSec: 5, committedSec: 2 });
    expect(playhead().style.left).toBe(`calc(${TAPE_LABEL_PX}px + 5 * ${TAPE_PX_MIN}px)`);
    expect(playhead().textContent).toBe("00:02.00");
  });

  test("the slider steps one encoded frame, taken from the encoder's own constant", () => {
    renderTape();
    expect(playheadSlider().getAttribute("step")).toBe(String(1 / MOTION_FPS));
    expect(playheadSlider().getAttribute("max")).toBe(String(DURATION));
  });

  test("the nudges commit a whole second, clamped to the clip, and start no clock", () => {
    const committed: number[] = [];
    render(<Driven onCommit={(sec) => committed.push(sec)} />);
    fireEvent.click(screen.getByRole("button", { name: messages.tapeNudgeForward }));
    fireEvent.click(screen.getByRole("button", { name: messages.tapeNudgeForward }));
    expect(committed).toEqual([1, 2]);

    fireEvent.click(screen.getByRole("button", { name: messages.tapeNudgeBack }));
    expect(committed).toEqual([1, 2, 1]);
  });

  test("a nudge cannot walk off either end of the clip", () => {
    const committed: number[] = [];
    render(<Driven onCommit={(sec) => committed.push(sec)} />);
    fireEvent.click(screen.getByRole("button", { name: messages.tapeNudgeBack }));
    expect(committed).toEqual([0]);

    for (let i = 0; i < DURATION + 2; i += 1) {
      fireEvent.click(screen.getByRole("button", { name: messages.tapeNudgeForward }));
    }
    expect(Math.max(...committed)).toBe(DURATION);
  });

  test("a click on the ruler commits the second under the pointer, at any scrollLeft", () => {
    const committed: number[] = [];
    render(<TimelineTape {...baseProps} onScrubCommit={(sec) => committed.push(sec)} />);
    const ruler = document.querySelector("[data-tape-ruler]") as HTMLElement;
    // happy-dom lays nothing out, so the port's rect is all zeros; the SCROLL
    // OFFSET is the term this asserts, and it is the one the sketch got wrong —
    // a ruler that does not share the clips' scrollLeft answers a click with the
    // wrong second the moment anybody scrolls.
    port().scrollLeft = 0;
    fireEvent.click(ruler, { clientX: TAPE_LABEL_PX + 2 * TAPE_PX_MIN });
    expect(committed).toEqual([2]);

    port().scrollLeft = TAPE_PX_MIN;
    fireEvent.click(ruler, { clientX: TAPE_LABEL_PX + 2 * TAPE_PX_MIN });
    expect(committed).toEqual([2, 3]);
  });

  test("a ruler click past either end is clamped, never a second the clip does not have", () => {
    const committed: number[] = [];
    render(<TimelineTape {...baseProps} onScrubCommit={(sec) => committed.push(sec)} />);
    const ruler = document.querySelector("[data-tape-ruler]") as HTMLElement;
    fireEvent.click(ruler, { clientX: 0 });
    fireEvent.click(ruler, { clientX: TAPE_LABEL_PX + 99 * TAPE_PX_MIN });
    expect(committed).toEqual([0, DURATION]);
  });

  test("a click on a CLIP selects it and does not also move the playhead", () => {
    // The clips are real buttons. Swallowing their click into a scrub would make
    // a beat unselectable by mouse — and would move the frame for a gesture that
    // asked for a selection.
    const committed: number[] = [];
    const picked: number[] = [];
    render(
      <TimelineTape
        {...baseProps}
        onScrubCommit={(sec) => committed.push(sec)}
        onSelectBeat={(i) => picked.push(i)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: messages.tapeBeatName(1) }), {
      clientX: TAPE_LABEL_PX + 2 * TAPE_PX_MIN,
    });
    expect(picked).toEqual([0]);
    expect(committed).toEqual([]);
  });
});

describe("(c) tokens only — no literal survives a theme toggle", () => {
  test("the source the checks below grep is really the tape", () => {
    // A read that failed must never present itself as "nothing found" — that is
    // the first of the two faults this repository keeps producing.
    expect(source.length).toBeGreaterThan(2000);
    expect(source).toContain("export const TimelineTape");
  });

  test("the tape's source carries no hex and no raw palette class", () => {
    // W0b.3 / DESIGN.md §1.1: a literal in a component is a defect. The sketch's
    // second anti-lesson was exactly this (`#6ee7ff`, `#e8a04a`, `#7b5cff`).
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    for (const forbidden of [
      "text-white",
      "bg-white",
      "bg-black",
      "bg-red-",
      "bg-cyan-",
      "bg-gray-",
      "text-gray-",
      "bg-slate-",
      "text-slate-",
    ]) {
      expect(source, `the tape must not use ${forbidden}`).not.toContain(forbidden);
    }
    // The emphasis token is what the playhead is drawn in, in both themes.
    expect(source).toContain("bg-text-emphasis");
  });

  test("no operator-facing string is written in the component", () => {
    /**
     * §7: every word the operator reads lives in `messages.ts`. Asserting
     * `getByText(messages.tapeNudgeBackGlyph)` would NOT catch a re-inlined
     * literal — the rendered text is identical either way — so this greps the
     * source for the glyphs as literals instead. The nudges' accessible names
     * always came from messages; their visible labels did not.
     */
    expect(source).toContain("messages.tapeNudgeBackGlyph");
    expect(source).toContain("messages.tapeNudgeForwardGlyph");
    expect(source).not.toMatch(/["'`>]\s*[−+-]1s\s*[<"'`]/);
    // And they still reach the screen, so the indirection is not merely tidy.
    expect(screen.queryByText(messages.tapeNudgeBackGlyph)).toBeNull();
    renderTape();
    expect(screen.getByText(messages.tapeNudgeBackGlyph)).toBeTruthy();
    expect(screen.getByText(messages.tapeNudgeForwardGlyph)).toBeTruthy();
  });

  test("the tape grows no theme switch of its own", () => {
    // The sketch's third anti-lesson: a second source of `cf:theme`.
    expect(source).not.toContain("cf:theme");
    expect(source).not.toContain("ThemeToggle");
  });
});

describe("(d) scrub is not an action, and nothing plays", () => {
  test("the module imports no reducer and dispatches nothing", () => {
    expect(source).not.toContain("editor-state");
    expect(source).not.toContain("EditorAction");
    expect(source).not.toMatch(/\bdispatch\b/);
  });

  test("there is no play clock and no second renderer", () => {
    // VE-D2 / VE-D5, and the sketch's first anti-lesson. A CALL, not the word:
    // the file's own doc comment names both APIs to say it does not use them.
    expect(source).not.toMatch(/requestAnimationFrame\s*\(/);
    expect(source).not.toMatch(/setInterval\s*\(/);
    expect(source).not.toMatch(/<video\b/);
    expect(source).not.toContain("scrub-bar");
  });

  test("the tape draws no picture of the creative — the perforation is CSS", () => {
    const { container } = renderTape();
    expect(container.querySelector("img")).toBeNull();
    expect(source).not.toContain("unsplash");
  });
});

describe("(e) / §6 — the assistive-technology contract", () => {
  test("exactly one control is named Playhead, in either host", () => {
    const rail = renderTape({ host: "rail" });
    expect(screen.getAllByLabelText(messages.tapePlayheadName)).toHaveLength(1);
    expect((rail.container.querySelector("[data-tape-host]") as HTMLElement).dataset.tapeHost).toBe(
      "rail",
    );
    rail.unmount();

    const section = renderTape({ host: "section" });
    expect(screen.getAllByLabelText(messages.tapePlayheadName)).toHaveLength(1);
    expect(
      (section.container.querySelector("[data-tape-host]") as HTMLElement).dataset.tapeHost,
    ).toBe("section");
  });

  test("the painted playhead has no tab stop and is hidden from the tree", () => {
    // Two playheads in the accessibility tree would announce the same fact twice.
    renderTape();
    expect(playhead().getAttribute("role")).toBe("presentation");
    expect(playhead().getAttribute("aria-hidden")).toBe("true");
    expect(playhead().querySelector("button, input, [tabindex]")).toBeNull();
  });

  test("a title clip is named by its position, never by its live seconds", () => {
    renderTape();
    const first = screen.getByRole("button", { name: messages.tapeBeatName(1) });
    expect(first.getAttribute("aria-label")).toBe("Beat 1");
    expect(first.getAttribute("aria-label")).not.toMatch(/\ds/);
    // The beat's own words stay discoverable without entering the name.
    expect(first.getAttribute("title")).toBe("Stay wild");
  });

  test("selecting a beat presses that button and only that one", () => {
    renderTape({ selectedBeatIndex: 1 });
    expect(
      screen.getByRole("button", { name: messages.tapeBeatName(1) }).getAttribute("aria-pressed"),
    ).toBe("false");
    expect(
      screen.getByRole("button", { name: messages.tapeBeatName(2) }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  test("a click on a clip asks the parent to select it — the tape owns no selection", () => {
    const picked: number[] = [];
    render(<TimelineTape {...baseProps} onSelectBeat={(i) => picked.push(i)} />);
    fireEvent.click(screen.getByRole("button", { name: messages.tapeBeatName(2) }));
    expect(picked).toEqual([1]);
  });

  test("an under-floor beat is invalid, described by the status, and SAID — not only painted", () => {
    const shortest = 3;
    const underFloor = beats.map((beat, index) => ({
      ...beat,
      underFloor: index === 1 && beatUnderFloor((beat.endT - beat.startT) * shortest),
    }));
    renderTape({ beats: underFloor, shortestDurationSec: shortest });

    const second = screen.getByRole("button", { name: messages.tapeBeatName(2) });
    expect(second.getAttribute("aria-invalid")).toBe("true");
    const describedBy = second.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();

    // The description is the beat's OWN, inside the beat's own clip — not a
    // shared status node that would describe every breach with the first one's
    // number. The existing sentence, not a new one (§7), and the dwell is
    // measured at the SHORTEST duration, where the floor actually binds.
    const described = document.getElementById(describedBy as string) as HTMLElement;
    expect(described.textContent).toBe(messages.timelineDwellUnderFloor(1, 1.2));
    expect(second.contains(described)).toBe(true);

    // The first beat clears the floor at 3 s and carries neither flag.
    const first = screen.getByRole("button", { name: messages.tapeBeatName(1) });
    expect(first.getAttribute("aria-invalid")).toBeNull();
    expect(first.getAttribute("aria-describedby")).toBeNull();
  });
});

describe("§7 — the status sentence", () => {
  test("idle first, then what the committed frame is", () => {
    render(<Driven />);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe(messages.tapeIdleStatus);

    fireEvent.change(playheadSlider(), { target: { value: "2.5" } });
    // A live move is not a commit: the sentence must not claim a frame landed.
    expect(status.textContent).toBe(messages.tapeIdleStatus);

    fireEvent.pointerUp(playheadSlider(), { target: { value: "2.5" } });
    expect(status.textContent).toBe(messages.tapeCommittedStatus("00:02.50"));
  });

  test("a commit made ELSEWHERE on the same second is still a commit", () => {
    // The rail hosts the dock's own scrub control beside the tape, writing the
    // SAME lifted second. The tape's sentence must follow the second, not only
    // its own buttons, or it contradicts the readout under its own diamond.
    const view = renderTape({ committedSec: 0 });
    expect(screen.getByRole("status").textContent).toBe(messages.tapeIdleStatus);

    view.rerender(<TimelineTape {...baseProps} committedSec={2} />);
    expect(screen.getByRole("status").textContent).toBe(messages.tapeCommittedStatus("00:02.00"));
  });

  test("a nudge that clamps to the second already committed still speaks", () => {
    // −1 s at 0 moves nothing, so the prop never changes — and it is still the
    // operator asking for that frame.
    render(<Driven />);
    fireEvent.click(screen.getByRole("button", { name: messages.tapeNudgeBack }));
    expect(screen.getByRole("status").textContent).toBe(messages.tapeCommittedStatus("00:00.00"));
  });

  test("each breaching beat announces ITS OWN dwell, not the first one's", () => {
    // Two beats under the floor, with different dwells. A single shared status
    // node described both with the first breach's number, so a screen reader on
    // beat 3 heard beat 2's seconds.
    const shortest = 3;
    const uneven: TimelineTapeBeat[] = [
      { text: "a", startT: 0, endT: 0.5, underFloor: false },
      { text: "b", startT: 0.5, endT: 0.7, underFloor: true },
      { text: "c", startT: 0.7, endT: 1, underFloor: true },
    ];
    renderTape({ beats: uneven, shortestDurationSec: shortest });

    const describedText = (position: number) => {
      const clip = screen.getByRole("button", { name: messages.tapeBeatName(position) });
      const id = clip.getAttribute("aria-describedby") as string;
      return (document.getElementById(id) as HTMLElement).textContent;
    };
    // 0.2 × 3 = 0.6s and 0.3 × 3 = 0.9s — two different numbers, each on its own
    // clip. If they were equal this test would pass on the shared-node defect.
    expect(describedText(2)).toBe(messages.timelineDwellUnderFloor(0.6000000000000001, 1.2));
    expect(describedText(3)).toBe(messages.timelineDwellUnderFloor(0.8999999999999999, 1.2));
    expect(describedText(2)).not.toBe(describedText(3));
  });

  test("an under-floor beat outranks the commit sentence", () => {
    render(<Driven beats={beats.map((b) => ({ ...b, underFloor: true }))} />);
    fireEvent.click(screen.getByRole("button", { name: messages.tapeNudgeForward }));
    expect(screen.getByRole("status").textContent).toBe(messages.timelineDwellUnderFloor(4, 1.2));
  });
});

describe("D147 — zoom is ephemeral, and fit is the default", () => {
  test("fitPx shows the whole clip, never zooms in past its cap, never below its floor", () => {
    // 6 s in a 1000 px port: (1000 − 52 − 32) / 6 = 152 → capped at the fit max.
    expect(fitPx(1000, DURATION)).toBe(TAPE_PX_FIT_MAX);
    // A narrow phone-width host: (390 − 52 − 32) / 30 = 10 → floored at the min.
    expect(fitPx(390, 30)).toBe(TAPE_PX_MIN);
    // In between, the arithmetic itself.
    expect(fitPx(390, 10)).toBe(30);
    // Not laid out yet, and a clip of no length: neither is a division.
    expect(fitPx(0, DURATION)).toBe(TAPE_PX_MIN);
    expect(fitPx(TAPE_LABEL_PX + TAPE_END_PAD_PX, DURATION)).toBe(TAPE_PX_MIN);
    expect(fitPx(1000, 0)).toBe(TAPE_PX_MIN);
  });

  test("the zoom control writes px/s and the whole surface follows it", () => {
    renderTape();
    const zoom = screen.getByLabelText(messages.tapeZoomName) as HTMLInputElement;
    expect(zoom.getAttribute("min")).toBe(String(TAPE_PX_MIN));
    expect(zoom.getAttribute("max")).toBe(String(TAPE_PX_MAX));

    fireEvent.change(zoom, { target: { value: "60" } });
    expect(canvas().style.width).toBe(
      `calc(${TAPE_LABEL_PX}px + ${DURATION} * 60px + ${TAPE_END_PAD_PX}px)`,
    );
    expect(screen.getByText(messages.tapePxPerSecond(60))).toBeTruthy();
    // One `pxPerSec`, so the ruler and the clips cannot disagree about a second.
    expect(ticks()[2].style.left).toBe(`calc(${TAPE_LABEL_PX}px + 2 * 60px)`);
  });

  test("a changed duration axis retires the operator's zoom rather than keeping it", () => {
    const view = renderTape();
    fireEvent.change(screen.getByLabelText(messages.tapeZoomName), { target: { value: "90" } });
    expect(screen.getByText(messages.tapePxPerSecond(90))).toBeTruthy();

    // 6 s → 15 s at a 6 s zoom leaves nine seconds off the right-hand edge: the
    // cutoff this plan closes, arriving by a different door.
    view.rerender(<TimelineTape {...baseProps} durationSec={15} />);
    expect(screen.getByText(messages.tapePxPerSecond(TAPE_PX_MIN))).toBeTruthy();
  });

  test("a real measurement re-fits, and a zero measurement is not a collapse", () => {
    // `ResizeObserver` never fires under happy-dom, so the fit path needs a real
    // one to be exercised at all — the same stub `use-min-inline-size` uses.
    const observers: ResizeObserverCallback[] = [];
    class FakeResizeObserver {
      constructor(readonly callback: ResizeObserverCallback) {
        observers.push(callback);
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    try {
      renderTape();
      expect(screen.getByText(messages.tapePxPerSecond(TAPE_PX_MIN))).toBeTruthy();

      const report = (width: number) =>
        act(() => {
          observers[0](
            [{ contentRect: { width } as DOMRectReadOnly } as ResizeObserverEntry],
            {} as ResizeObserver,
          );
        });

      report(400);
      // (400 − 52 − 32) / 6 = 52.6 → 52, capped at the fit max.
      expect(screen.getByText(messages.tapePxPerSecond(TAPE_PX_FIT_MAX))).toBeTruthy();

      report(0);
      // A zero is "not laid out", never a real collapse: the verdict stands.
      expect(screen.getByText(messages.tapePxPerSecond(TAPE_PX_FIT_MAX))).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("the tape's clock", () => {
  test("floors to the centisecond without an IEEE-754 tail", () => {
    expect(formatTapeClock(0)).toBe("00:00.00");
    // 6.4 − 6 is 0.3999999999999995: a naive fractional floor names 00:06.39.
    expect(formatTapeClock(6.4)).toBe("00:06.40");
    expect(formatTapeClock(8.29)).toBe("00:08.29");
    expect(formatTapeClock(65.5)).toBe("01:05.50");
    // Floored, not rounded: a label must never name a frame the scrub has not
    // reached — 1/30 s is 0.0333…, and that is 3 centiseconds, not 4.
    expect(formatTapeClock(1 / MOTION_FPS)).toBe("00:00.03");
    expect(formatTapeClock(-2)).toBe("00:00.00");
  });
});

describe("§3.7 — reduced motion", () => {
  test("the root wears the class the media query targets", () => {
    const { container } = renderTape();
    expect(container.querySelector(".timeline-tape")).not.toBeNull();
  });
});

describe("the beat-floor helper", () => {
  test("uses the domain's own slack, so the tape and the validator agree", () => {
    // The input has to be one where the two formulas actually DISAGREE, or the
    // assertion pins nothing: `3.5999999999999996 / 3` is 1.1999999999999999556
    // and is under neither comparison. The value the TAPE really computes is
    // `(endT - startT) * shortestDurationSec` — a resolved window times the
    // duration, not a division — and three equal beats on a 3 × MIN_DWELL_SEC
    // axis give 1.1999999999999997335, which a strict `<` marks as a breach and
    // `timelineProblem` accepts. That is the disagreement, and it is the one an
    // operator would meet as an error they cannot clear.
    const threeEqualBeats = resolveTimeline(
      {
        beats: [
          { text: "a", weight: 1 },
          { text: "b", weight: 1 },
          { text: "c", weight: 1 },
        ],
        transition: "cut",
        keyBeat: 1,
      },
      3 * 1.2,
    );
    const dwell = (threeEqualBeats[0].endT - threeEqualBeats[0].startT) * (3 * 1.2);
    expect(dwell).toBeLessThan(1.2);
    expect(beatUnderFloor(dwell)).toBe(false);

    // The slack is a hair, not a licence: a beat a hundredth under the floor is
    // still a breach, and one exactly on it is not.
    expect(beatUnderFloor(1.2)).toBe(false);
    expect(beatUnderFloor(1.19)).toBe(true);
  });
});

describe("the lanes TS1 ships", () => {
  test("Title and Video, and no empty B-roll or audio lane implying a bed", () => {
    const { container } = renderTape();
    const laneNames = [...container.querySelectorAll(".sticky")].map((el) => el.textContent);
    expect(laneNames).toEqual([messages.tapeLaneTitle, messages.tapeLaneVideo]);
    // TL2 and TL4 paint onto this coordinate system later; an empty waveform now
    // would imply a bed the brief does not carry.
    expect(container.textContent).not.toContain("B-roll");
    expect(container.textContent).not.toContain("Audio");
  });

  test("the video lane draws one clip across the whole clip length", () => {
    const { container } = renderTape();
    expect(container.querySelectorAll('[data-tape-clip="video"]')).toHaveLength(1);
    expect(videoClip().style.width).toBe(`calc(${DURATION} * ${TAPE_PX_MIN}px)`);
  });

  test("the video clip is NOT a control — it has nothing to do and no tab stop", () => {
    // A focusable `button` that does nothing wastes a keyboard user's time and
    // announces an affordance this surface does not have. The video clip is the
    // projection of the creative, not something to pick.
    renderTape();
    expect(screen.queryByRole("button", { name: messages.tapeVideoClip })).toBeNull();
    const video = videoClip();
    expect(video.tagName).toBe("DIV");
    expect(video.getAttribute("tabindex")).toBeNull();
    expect(video.querySelector("button, input, [tabindex]")).toBeNull();
    // A beat clip, by contrast, IS a control — the sibling proof that this test
    // is about the video clip and not about clips in general.
    expect(screen.getByRole("button", { name: messages.tapeBeatName(1) }).tagName).toBe("BUTTON");
  });
});

describe("TL6 — keyframe diamonds on the ruler", () => {
  const diamond = (over: Partial<TrackDiamond> = {}): TrackDiamond => ({
    trackIndex: 0,
    stopIndex: 0,
    property: "opacity",
    t: 0.5,
    sec: DURATION / 2,
    ...over,
  });
  const withKeys = (
    placed: readonly TrackDiamond[],
    unplaceable = 0,
    onDiamondCommit = vi.fn(),
  ) => {
    const view = renderTape({
      diamonds: { placed, unplaceable: { count: unplaceable } },
      onDiamondCommit,
    });
    return { view, onDiamondCommit };
  };
  const key = (name: string) => screen.getByRole("slider", { name });

  test("no keys means no lane — an empty one would imply this creative has some", () => {
    // TS1's own rule, which this lane is subject to: "an empty waveform now
    // would imply a bed the brief does not carry".
    const { container } = renderTape({ diamonds: { placed: [], unplaceable: { count: 0 } } });
    const laneNames = [...container.querySelectorAll(".sticky")].map((el) => el.textContent);
    expect(laneNames).not.toContain(messages.tapeLaneKeyframes);
  });

  test("a key is a NATIVE range, so the guided swipe cannot swallow it (§9.3.5)", () => {
    withKeys([diamond()]);
    const el = key(messages.tapeDiamondName(messages.TRACK_PROPERTY_LABEL.opacity!, 0));
    // `use-step-navigation` hands a drag to `[role="slider"]`,
    // `input[type="range"]` or `[draggable="true"]` and nothing else.
    expect(el.tagName).toBe("INPUT");
    expect(el.getAttribute("type")).toBe("range");
  });

  test("the name is stable and `aria-valuenow` is the COMMITTED t (§9.3.2, §9.3.3)", () => {
    withKeys([diamond({ t: 0.25, sec: DURATION / 4 })]);
    const el = key(messages.tapeDiamondName(messages.TRACK_PROPERTY_LABEL.opacity!, 0));
    fireEvent.change(el, { target: { value: String(DURATION * 0.9) } });
    // Dragged nine tenths along, and BOTH still describe the committed stop —
    // a control that renamed itself or re-announced its value every pixel is
    // the failure these two points exist to prevent.
    expect(el.getAttribute("aria-label")).toBe(
      messages.tapeDiamondName(messages.TRACK_PROPERTY_LABEL.opacity!, 0),
    );
    expect(el.getAttribute("aria-valuenow")).toBe("0.25");
  });

  test("a drag commits exactly once, on release", () => {
    const { onDiamondCommit } = withKeys([diamond()]);
    const el = key(messages.tapeDiamondName(messages.TRACK_PROPERTY_LABEL.opacity!, 0));
    fireEvent.change(el, { target: { value: "1" } });
    fireEvent.change(el, { target: { value: "2" } });
    fireEvent.change(el, { target: { value: "3" } });
    expect(onDiamondCommit).not.toHaveBeenCalled();
    fireEvent.pointerUp(el);
    expect(onDiamondCommit).toHaveBeenCalledTimes(1);
    expect(onDiamondCommit).toHaveBeenCalledWith(0, 0, 3);
  });

  test("a keyboard user commits too — the pointer is not the only way", () => {
    const { onDiamondCommit } = withKeys([diamond()]);
    const el = key(messages.tapeDiamondName(messages.TRACK_PROPERTY_LABEL.opacity!, 0));
    fireEvent.change(el, { target: { value: "2" } });
    fireEvent.keyUp(el, { key: "ArrowRight" });
    expect(onDiamondCommit).toHaveBeenCalledWith(0, 0, 2);
  });

  test("beat-timed keys are counted and explained, never placed", () => {
    // A beat-clock stop's `t` is beat-LOCAL: at 0.5 it fires at the midpoint of
    // EVERY beat, so it has no single second to sit at. One diamond would be a
    // lie; several would make a drag ambiguous about which it moved.
    const { container } = renderTape({
      diamonds: { placed: [], unplaceable: { count: 3 } },
    });
    expect(container.querySelectorAll("[data-tape-diamond]")).toHaveLength(0);
    expect(container.textContent).toContain(messages.tapeKeysNotPlaced(3));
  });

  test("one unplaceable key is said in the singular", () => {
    const { container } = renderTape({ diamonds: { placed: [], unplaceable: { count: 1 } } });
    expect(container.textContent).toContain(messages.tapeKeysNotPlaced(1));
    expect(messages.tapeKeysNotPlaced(1)).not.toEqual(messages.tapeKeysNotPlaced(2));
  });

  test("each key sits at its own second", () => {
    const { container } = withKeys([
      diamond({ stopIndex: 0, t: 0, sec: 0 }),
      diamond({ stopIndex: 1, t: 1, sec: DURATION }),
    ]).view;
    const els = [...container.querySelectorAll("[data-tape-diamond]")] as HTMLInputElement[];
    expect(els).toHaveLength(2);
    expect(els[0]!.style.left).toBe(`calc(${TAPE_LABEL_PX}px + 0 * ${TAPE_PX_MIN}px)`);
    expect(els[1]!.style.left).toBe(`calc(${TAPE_LABEL_PX}px + ${DURATION} * ${TAPE_PX_MIN}px)`);
  });
});
