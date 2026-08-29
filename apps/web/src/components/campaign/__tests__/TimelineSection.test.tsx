import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { resolveTimeline, timelineProblem } from "@campaignfoundry/CampaignOrchestration/copy-timeline";
import { TimelineSection } from "../TimelineSection";
import * as messages from "../messages";
import {
  initialEditorState,
  editorReducer,
  MAX_BEATS,
  MIN_DWELL_SEC,
  asCopyTimeline,
  type EditorState,
} from "../editor-state";

const withBeats = (
  beats: { text: string; weight: number }[],
  over: Partial<EditorState> = {},
): EditorState => ({
  ...initialEditorState(),
  mode: "variation",
  briefId: "camp",
  timeline: { beats: beats.map((b, i) => ({ key: i + 1, ...b })), transition: "fade", keyBeat: 1 },
  ...over,
});

/** Render the panel with a live reducer, so the assertions run against real state. */
function renderLive(initial: EditorState) {
  let state = initial;
  const dispatch = vi.fn((action: Parameters<typeof editorReducer>[1]) => {
    state = editorReducer(state, action);
    rerender(<TimelineSection state={state} dispatch={dispatch} />);
  });
  const { rerender } = render(<TimelineSection state={state} dispatch={dispatch} />);
  return { get state() { return state; }, dispatch };
}

describe("TimelineSection — beat rows (E5.2)", () => {
  test("an empty sequence says so and offers a first beat", () => {
    render(<TimelineSection state={withBeats([])} dispatch={vi.fn()} />);
    expect(screen.getByText(messages.timelineEmpty)).toBeTruthy();
    expect((screen.getByRole("button", { name: messages.timelineAddBeat }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("each beat gets a text field, a share stepper and a poster control", async () => {
    const user = userEvent.setup();
    const live = renderLive(withBeats([{ text: "One", weight: 1 }, { text: "Two", weight: 2 }]));

    await user.type(screen.getByLabelText(messages.timelineBeatTextLabel(1)), "!");
    expect(live.state.timeline.beats[0]?.text).toBe("One!");

    // The poster follows the beat the user picks, 1-based in the brief.
    await user.click(screen.getByLabelText(messages.timelineKeyBeatLabel(2)));
    expect(live.state.timeline.keyBeat).toBe(2);
  });

  test("reordering moves the row and carries the poster with it", async () => {
    const user = userEvent.setup();
    const live = renderLive(
      withBeats([{ text: "One", weight: 1 }, { text: "Two", weight: 1 }, { text: "Three", weight: 1 }]),
    );
    await user.click(screen.getByLabelText(messages.timelineKeyBeatLabel(1)));
    await user.click(screen.getByLabelText(messages.timelineMoveBeatDown(1)));
    expect(live.state.timeline.beats.map((b) => b.text)).toEqual(["Two", "One", "Three"]);
    expect(live.state.timeline.keyBeat).toBe(2);
  });

  test("a beat's row keeps its identity across a move, so a second press moves the same beat", async () => {
    // Keyed by array position, React hands the moved beat's DOM node to its neighbour:
    // focus stays on the position and the second press moves a DIFFERENT beat. Keyed by a
    // stable beat identity, the node moves with the beat and focus follows it.
    const user = userEvent.setup();
    const live = renderLive(
      withBeats([{ text: "One", weight: 1 }, { text: "Two", weight: 1 }, { text: "Three", weight: 1 }], {
        duration: [30],
      }),
    );
    await user.click(screen.getByLabelText(messages.timelineMoveBeatDown(1)));
    expect(live.state.timeline.beats.map((b) => b.text)).toEqual(["Two", "One", "Three"]);

    // The focused control is still the one belonging to the beat that just moved.
    await user.click(document.activeElement as HTMLElement);
    expect(live.state.timeline.beats.map((b) => b.text)).toEqual(["Two", "Three", "One"]);
  });

  test("the ends cannot be moved past the ends", () => {
    render(<TimelineSection state={withBeats([{ text: "One", weight: 1 }, { text: "Two", weight: 1 }])} dispatch={vi.fn()} />);
    expect((screen.getByLabelText(messages.timelineMoveBeatUp(1)) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText(messages.timelineMoveBeatDown(2)) as HTMLButtonElement).disabled).toBe(true);
  });

  test("the share stepper writes the beat's weight", async () => {
    const user = userEvent.setup();
    const live = renderLive(withBeats([{ text: "One", weight: 2 }, { text: "Two", weight: 2 }], { duration: [30] }));
    // The Stepper prefixes its own verb onto the field's label.
    await user.click(screen.getByRole("button", { name: "Increase " + messages.timelineBeatWeightLabel(1) }));
    expect(live.state.timeline.beats[0]?.weight).toBe(3);
  });

  test("moving a beat earlier is the mirror of moving it later", async () => {
    const user = userEvent.setup();
    const live = renderLive(withBeats([{ text: "One", weight: 1 }, { text: "Two", weight: 1 }]));
    await user.click(screen.getByLabelText(messages.timelineMoveBeatUp(2)));
    expect(live.state.timeline.beats.map((b) => b.text)).toEqual(["Two", "One"]);
  });

  test("Add appends a beat when the floor allows it", async () => {
    const user = userEvent.setup();
    const live = renderLive(withBeats([{ text: "One", weight: 1 }], { duration: [30] }));
    await user.click(screen.getByRole("button", { name: messages.timelineAddBeat }));
    expect(live.state.timeline.beats).toHaveLength(2);
  });

  test("the transition control writes cut and fade", async () => {
    const user = userEvent.setup();
    const live = renderLive(withBeats([{ text: "One", weight: 1 }, { text: "Two", weight: 1 }], { duration: [30] }));
    await user.click(screen.getByRole("button", { name: messages.timelineTransitionCut }));
    expect(live.state.timeline.transition).toBe("cut");
    await user.click(screen.getByRole("button", { name: messages.timelineTransitionFade }));
    expect(live.state.timeline.transition).toBe("fade");
  });

  test("removing a beat removes exactly that row", async () => {
    const user = userEvent.setup();
    const live = renderLive(withBeats([{ text: "One", weight: 1 }, { text: "Two", weight: 1 }]));
    await user.click(screen.getByLabelText(messages.timelineRemoveBeat(1)));
    expect(live.state.timeline.beats.map((b) => b.text)).toEqual(["Two"]);
  });
});

describe("TimelineSection — the dwell floor (E5.2/D3)", () => {
  test("Add is disabled with a reason naming the shortest clip", () => {
    // Four beats on a 6 s clip: a fifth would give each 1.2 s exactly, and one weight-1
    // beat among heavier ones drops under. 6 s is the default when no axis is set.
    const state = withBeats(
      [
        { text: "One", weight: 1 },
        { text: "Two", weight: 1 },
        { text: "Three", weight: 1 },
        { text: "Four", weight: 2 },
      ],
      { duration: [5] },
    );
    render(<TimelineSection state={state} dispatch={vi.fn()} />);
    expect((screen.getByRole("button", { name: messages.timelineAddBeat }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(messages.timelineAddBlockedFloor(5, MIN_DWELL_SEC))).toBeTruthy();
  });

  test("the reason re-derives from the duration axis, not from the add path", () => {
    // THE case the plan calls out: the same three beats are fine on a long clip and
    // breach the floor on a short one, with no beat having been added or changed.
    const beats = [
      { text: "One", weight: 1 },
      { text: "Two", weight: 1 },
      { text: "Three", weight: 1 },
    ];
    const { unmount } = render(<TimelineSection state={withBeats(beats, { duration: [30] })} dispatch={vi.fn()} />);
    expect((screen.getByRole("button", { name: messages.timelineAddBeat }) as HTMLButtonElement).disabled).toBe(false);
    unmount();

    render(<TimelineSection state={withBeats(beats, { duration: [4] })} dispatch={vi.fn()} />);
    expect((screen.getByRole("button", { name: messages.timelineAddBeat }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(messages.timelineAddBlockedFloor(4, MIN_DWELL_SEC))).toBeTruthy();
  });

  test("the shortest clip in the axis is the one the reason names", () => {
    // Two equal beats plus a third would be 1.0s each on a 3s clip and 4.0s on a 12s one.
    // The floor is measured against the shortest, so 3 is the number the reason must say.
    const state = withBeats([{ text: "One", weight: 1 }, { text: "Two", weight: 1 }], { duration: [30, 3, 12] });
    render(<TimelineSection state={state} dispatch={vi.fn()} />);
    expect((screen.getByRole("button", { name: messages.timelineAddBeat }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(messages.timelineAddBlockedFloor(3, MIN_DWELL_SEC))).toBeTruthy();
  });

  test("Add is disabled at the beat ceiling, for a different reason", () => {
    const beats = Array.from({ length: MAX_BEATS }, (_, i) => ({ text: `B${i}`, weight: 1 }));
    render(<TimelineSection state={withBeats(beats, { duration: [30] })} dispatch={vi.fn()} />);
    expect((screen.getByRole("button", { name: messages.timelineAddBeat }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(messages.timelineAddBlockedMax(MAX_BEATS))).toBeTruthy();
  });
});

describe("TimelineSection — insert from the approved pool (E5.4)", () => {
  const pool = (entries: { text: string; status: string }[]) =>
    ({ entries: entries.map((e, i) => ({ id: `e${i}`, text: e.text, status: e.status })) }) as unknown as EditorState["pool"];

  test("only approved copy is offered, and inserting it becomes a beat", async () => {
    const user = userEvent.setup();
    const live = renderLive(
      withBeats([], {
        duration: [30],
        pool: pool([
          { text: "Approved line", status: "approved" },
          { text: "Rejected line", status: "rejected" },
          { text: "Pending line", status: "pending" },
        ]),
      }),
    );
    expect(screen.queryByLabelText(messages.timelineInsertBeat("Rejected line"))).toBeNull();
    expect(screen.queryByLabelText(messages.timelineInsertBeat("Pending line"))).toBeNull();

    await user.click(screen.getByLabelText(messages.timelineInsertBeat("Approved line")));
    // The key is an internal React identity; the assertion is about authored content.
    expect(live.state.timeline.beats.map((b) => ({ text: b.text, weight: b.weight }))).toEqual([
      { text: "Approved line", weight: 1 },
    ]);
  });

  test("the same approved line twice is offered once", () => {
    render(
      <TimelineSection
        state={withBeats([], {
          duration: [30],
          pool: pool([
            { text: "Same", status: "approved" },
            { text: "Same", status: "approved" },
          ]),
        })}
        dispatch={vi.fn()}
      />,
    );
    expect(screen.getAllByLabelText(messages.timelineInsertBeat("Same"))).toHaveLength(1);
  });

  test("nothing is offered when adding is blocked — a control that cannot act is not shown", () => {
    const beats = Array.from({ length: MAX_BEATS }, (_, i) => ({ text: `B${i}`, weight: 1 }));
    render(
      <TimelineSection
        state={withBeats(beats, { duration: [30], pool: pool([{ text: "Approved line", status: "approved" }]) })}
        dispatch={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText(messages.timelineInsertBeat("Approved line"))).toBeNull();
  });

  test("no pool means no insert row at all", () => {
    render(<TimelineSection state={withBeats([], { duration: [30] })} dispatch={vi.fn()} />);
    expect(screen.queryByText(messages.timelineInsertLegend)).toBeNull();
  });
});

describe("TimelineSection — the proportion bar (E5.3)", () => {
  test("every second it shows is resolveTimeline's, for every clip length in the axis", () => {
    // The point of this test: the bar must not compute its own shares. If it ever divides
    // weights itself, this fails the moment the domain changes how a window is derived.
    const beats = [
      { text: "One", weight: 2 },
      { text: "Two", weight: 3 },
      { text: "Three", weight: 2 },
    ];
    const state = withBeats(beats, { duration: [12, 30] });
    render(<TimelineSection state={state} dispatch={vi.fn()} />);

    for (const durationSec of [12, 30]) {
      expect(screen.getByText(messages.timelineProportionCaption(durationSec))).toBeTruthy();
      for (const beat of resolveTimeline(asCopyTimeline(state.timeline), durationSec)) {
        const dwellSec = (beat.endT - beat.startT) * durationSec;
        expect(screen.getAllByText(messages.timelineDwell(dwellSec)).length).toBeGreaterThan(0);
      }
    }
  });

  test("a beat under the floor is marked as under it, not merely shown", () => {
    const state = withBeats(
      [
        { text: "Long", weight: 20 },
        { text: "Blink", weight: 1 },
      ],
      { duration: [6] },
    );
    render(<TimelineSection state={state} dispatch={vi.fn()} />);
    const resolved = resolveTimeline(asCopyTimeline(state.timeline), 6);
    const blink = (resolved[1].endT - resolved[1].startT) * 6;
    expect(blink).toBeLessThan(MIN_DWELL_SEC);
    expect(screen.getAllByText(messages.timelineDwellUnderFloor(blink, MIN_DWELL_SEC)).length).toBeGreaterThan(0);
  });

  test("a beat exactly on the floor is not painted as under it", () => {
    // Five equal beats on a 6 s clip. The domain computes (6 × 1) / 5 = 1.2 and accepts it;
    // the bar computes (endT - startT) × 6 = 1.1999999999999997 from cumulative windows.
    // Without the domain's own tolerance the bar paints a valid draft red — the validator
    // and the picture disagreeing about the same timeline.
    const beats = Array.from({ length: 5 }, (_, i) => ({ text: `B${i}`, weight: 1 }));
    const state = withBeats(beats, { duration: [6] });
    // Which beat trips it depends on where the cumulative rounding lands — find it rather
    // than hard-coding an index that a change to resolveTimeline could move.
    const resolved = resolveTimeline(asCopyTimeline(state.timeline), 6);
    const dwells = resolved.map((beat) => (beat.endT - beat.startT) * 6);
    const dwellSec = dwells.find((d) => d < MIN_DWELL_SEC);
    expect(dwellSec).toBeDefined();
    if (dwellSec === undefined) return;
    expect(dwellSec).toBeGreaterThan(MIN_DWELL_SEC - 1e-6);
    // The domain accepts it: (6 × 1) / 5 is exactly 1.2.
    expect(timelineProblem(asCopyTimeline(state.timeline), [6])).toBeUndefined();

    render(<TimelineSection state={state} dispatch={vi.fn()} />);
    expect(screen.queryByText(messages.timelineDwellUnderFloor(dwellSec, MIN_DWELL_SEC))).toBeNull();
    expect(screen.getAllByText(messages.timelineDwell(dwellSec)).length).toBeGreaterThan(0);
  });

  test("with no beats there is no bar to read", () => {
    render(<TimelineSection state={withBeats([], { duration: [6] })} dispatch={vi.fn()} />);
    expect(screen.queryByText(messages.timelineProportionCaption(6))).toBeNull();
  });
});
