import { describe, test, expect } from "vitest";
import {
  editorReducer,
  initialEditorState,
  asCopyTimeline,
  timelineDurations,
  type EditorState,
} from "../editor-state";
import { dwellProblem, MAX_WEIGHT } from "@campaignfoundry/CampaignOrchestration/copy-timeline";

/** A motion draft that can serialise a timeline, with the given weights. */
const withWeights = (weights: readonly number[]): EditorState => {
  let state: EditorState = {
    ...initialEditorState("variation"),
    formats: ["motion"],
    campaignMessage: "Hello",
    duration: [6],
  };
  weights.forEach((weight, index) => {
    state = editorReducer(state, { type: "addBeat" });
    state = editorReducer(state, { type: "setBeatText", index, text: `B${index}` });
    state = editorReducer(state, { type: "setBeatWeight", index, weight });
  });
  return state;
};

const weightsOf = (state: EditorState): number[] => state.timeline.beats.map((beat) => beat.weight);

const shift = (state: EditorState, boundary: number, delta: number): EditorState =>
  editorReducer(state, { type: "shiftBeatBoundary", boundary, delta });

describe("shiftBeatBoundary (TL3)", () => {
  test("a neighbour transfer moves weight between adjacent beats", () => {
    const after = shift(withWeights([3, 3]), 0, 1);
    expect(weightsOf(after)).toEqual([4, 2]);
  });

  test("a negative delta moves weight the other way", () => {
    const after = shift(withWeights([3, 3]), 0, -1);
    expect(weightsOf(after)).toEqual([2, 4]);
  });

  test("only the two neighbours move — the rest of the sequence is untouched", () => {
    const before = withWeights([2, 3, 2]);
    const after = shift(before, 1, 1);
    expect(weightsOf(after)).toEqual([2, 4, 1]);
    expect(after.timeline.beats[0]).toBe(before.timeline.beats[0]);
    expect(after.timeline.beats[0]?.text).toBe("B0");
    expect(after.timeline.beats[1]?.text).toBe("B1");
    expect(after.timeline.beats[2]?.text).toBe("B2");
  });

  test("a transfer that would push a neighbour below 1 is a no-op", () => {
    const before = withWeights([1, 3]);
    expect(shift(before, 0, -1)).toBe(before);
    expect(shift(before, 0, 3)).toBe(before);
  });

  test("a transfer that would push a neighbour above MAX_WEIGHT is a no-op", () => {
    const before = withWeights([MAX_WEIGHT, 2]);
    expect(shift(before, 0, 1)).toBe(before);
    const other = withWeights([2, MAX_WEIGHT]);
    expect(shift(other, 0, -1)).toBe(other);
  });

  test("a non-integer delta or an out-of-range boundary is a no-op", () => {
    const before = withWeights([3, 3, 3]);
    for (const delta of [0.5, Number.NaN, 1.5]) {
      expect(shift(before, 0, delta)).toBe(before);
    }
    for (const boundary of [-1, 2, 9, 0.5, 1.2]) {
      expect(shift(before, boundary, 1)).toBe(before);
    }
    expect(shift(before, 0, 0)).toBe(before);
  });

  test("a one-beat sequence has no join, so any shift is a no-op", () => {
    const before = withWeights([4]);
    expect(shift(before, 0, 1)).toBe(before);
  });

  /**
   * D138: the dwell floor is detection, not prevention. A transfer that would
   * leave a neighbour under the floor is still written; `dwellProblem` on the
   * SIMULATED (here, committed) timeline is how the floor is asked — never a
   * literal 1.2 in this reducer.
   */
  test("a floor-breaching transfer is committed and flagged, not prevented", () => {
    const before = withWeights([3, 3]);
    expect(
      dwellProblem(asCopyTimeline(before.timeline), timelineDurations(before)),
    ).toBeUndefined();
    const after = shift(before, 0, 2);
    expect(weightsOf(after)).toEqual([5, 1]);
    expect(dwellProblem(asCopyTimeline(after.timeline), timelineDurations(after))).toBeDefined();
  });

  test("a neighbour's scene and identity survive the transfer", () => {
    let state = withWeights([3, 3]);
    state = editorReducer(state, {
      type: "setBeatBackground",
      index: 1,
      background: "assets/inputs/camp/dusk.png",
    });
    const after = shift(state, 0, 1);
    expect(after.timeline.beats[0]?.key).toBe(state.timeline.beats[0]?.key);
    expect(after.timeline.beats[1]?.key).toBe(state.timeline.beats[1]?.key);
    expect(after.timeline.beats[1]?.background).toBe("assets/inputs/camp/dusk.png");
    expect(after.timeline.beats[0]?.background).toBeUndefined();
  });
});
