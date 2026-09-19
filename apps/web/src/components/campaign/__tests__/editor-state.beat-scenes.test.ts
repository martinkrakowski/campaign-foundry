import { describe, test, expect } from "vitest";
import { editorReducer, initialEditorState, toBrief, type EditorState } from "../editor-state";
import { validateCopy } from "../validate";
import * as messages from "../messages";
import { MAX_SCENES } from "@campaignfoundry/CampaignOrchestration/copy-timeline";

/** A motion draft whose timeline can actually serialise, with `n` beats. */
const withBeats = (n: number): EditorState => {
  let state = initialEditorState("variation");
  state = { ...state, formats: ["motion"], campaignMessage: "Hello" };
  for (let i = 0; i < n; i += 1) state = editorReducer(state, { type: "addBeat" });
  return state;
};

const scene = (state: EditorState, index: number, background?: string): EditorState =>
  editorReducer(state, { type: "setBeatBackground", index, background });

describe("setBeatBackground (TL2)", () => {
  test("attaching names the beat's own scene", () => {
    const after = scene(withBeats(2), 1, "assets/inputs/camp/dusk.png");
    expect(after.timeline.beats[1]?.background).toBe("assets/inputs/camp/dusk.png");
    // The other beat is untouched — it still shows the creative's ground.
    expect(after.timeline.beats[0]?.background).toBeUndefined();
  });

  /**
   * The contract the lane row states outright: clearing DELETES the key. An own
   * property holding `undefined` is a different object to `canonicalJson`, and
   * X33's `hashCopy` serialises `copy.timeline` in full — so the two spellings
   * would hash differently for a beat the operator has left in the same state,
   * and a selective re-roll would be refused for a change nobody made.
   */
  test("clearing deletes the key rather than writing undefined", () => {
    const attached = scene(withBeats(1), 0, "assets/inputs/camp/dusk.png");
    const cleared = scene(attached, 0, undefined);
    expect(cleared.timeline.beats[0]?.background).toBeUndefined();
    expect(Object.hasOwn(cleared.timeline.beats[0]!, "background")).toBe(false);
  });

  /**
   * An EMPTY string clears, because that is `isNamedBackground`'s line — the one
   * `toBrief` serialises by. The reducer reuses it rather than inventing its own
   * idea of "named", so the draft can never hold a value the brief would drop.
   *
   * Deliberately not a trim: `isNamedBackground` is `!== ""`, so a whitespace-only
   * path is a name to both. An earlier draft of this test asserted `"   "` clears
   * — a rule that exists nowhere in the codebase — and failed. The rule was right
   * and the test was wrong.
   */
  test("an empty string clears, on the same line the serialiser draws", () => {
    const after = scene(scene(withBeats(1), 0, "assets/inputs/camp/dusk.png"), 0, "");
    expect(Object.hasOwn(after.timeline.beats[0]!, "background")).toBe(false);
  });

  test("an out-of-range index is a no-op, never a beat invented at the end", () => {
    const before = withBeats(2);
    const after = scene(before, 7, "assets/inputs/camp/dusk.png");
    expect(after).toBe(before);
    expect(after.timeline.beats).toHaveLength(2);
  });

  test("set then clear leaves the projected brief byte-identical", () => {
    const before = withBeats(2);
    const roundTrip = scene(scene(before, 0, "assets/inputs/camp/dusk.png"), 0, undefined);
    expect(JSON.stringify(toBrief(roundTrip))).toBe(JSON.stringify(toBrief(before)));
  });
});

describe("the scene cap is the domain's rule, called (TL2)", () => {
  /** Distinct scenes, one per beat. */
  const distinct = (n: number): EditorState => {
    let state = withBeats(n);
    for (let i = 0; i < n; i += 1) state = scene(state, i, `assets/inputs/camp/s${i}.png`);
    return state;
  };

  test(`${MAX_SCENES} distinct scenes are accepted`, () => {
    expect(validateCopy(distinct(MAX_SCENES))["copy-timeline"]).toBeUndefined();
  });

  test("the fourth distinct scene is refused", () => {
    expect(validateCopy(distinct(MAX_SCENES + 1))["copy-timeline"]).toBe(
      messages.timelineTooManyBackgrounds(MAX_SCENES),
    );
  });

  /**
   * The rule the cap is actually made of, and the reason it is worth calling the
   * domain rather than counting here: repeats are ONE scene, and beats naming
   * none spend nothing. A naive `beats.filter(b => b.background).length` passes
   * the two tests above and fails this one.
   */
  test("repeats are one scene, and beats naming none spend nothing", () => {
    let state = withBeats(MAX_SCENES + 3);
    for (let i = 0; i < MAX_SCENES + 3; i += 1) {
      // Every beat names the SAME scene, so the timeline spends exactly one.
      state = scene(state, i, "assets/inputs/camp/one.png");
    }
    expect(validateCopy(state)["copy-timeline"]).toBeUndefined();
  });
});
