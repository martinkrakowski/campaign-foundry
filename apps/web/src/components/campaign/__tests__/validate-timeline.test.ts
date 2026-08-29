import { describe, test, expect } from "vitest";
import {
  timelineProblem,
  MAX_BEATS,
  MAX_WEIGHT,
  MIN_DWELL_SEC,
} from "@campaignfoundry/CampaignOrchestration/copy-timeline";
import { validateTimeline } from "../validate";
import * as messages from "../messages";
import { initialEditorState, asCopyTimeline, timelineDurations, toBrief, type EditorState } from "../editor-state";

const draft = (
  beats: { text: string; weight: number }[],
  over: Partial<EditorState> = {},
): EditorState => ({
  ...initialEditorState(),
  mode: "variation",
  briefId: "camp",
  timeline: { beats: beats.map((b, i) => ({ key: i + 1, ...b })), transition: "fade", keyBeat: 1 },
  ...over,
});

/** Did the editor flag anything about the timeline? */
const flagged = (state: EditorState): boolean => Object.keys(validateTimeline(state)).length > 0;
/** Would the domain refuse it? */
const refused = (state: EditorState): boolean =>
  timelineProblem(asCopyTimeline(state.timeline), timelineDurations(state)) !== undefined;

describe("validateTimeline mirrors timelineProblem (E5.5)", () => {
  /**
   * The point of this table: the editor and the domain must agree about WHICH drafts are
   * invalid. The wording deliberately differs — the domain names fields the way a brief
   * file spells them, which is wrong on screen (D2/D18) — so the agreement has to be
   * asserted on the verdict, not the string.
   */
  const cases: [string, EditorState][] = [
    ["a sound two-beat sequence", draft([{ text: "One", weight: 1 }, { text: "Two", weight: 1 }], { duration: [30] })],
    ["one beat holding the whole clip", draft([{ text: "Only", weight: 1 }], { duration: [6] })],
    [
      "more beats than a sequence holds",
      draft(Array.from({ length: MAX_BEATS + 1 }, (_, i) => ({ text: `B${i}`, weight: 1 })), { duration: [30] }),
    ],
    ["a fractional share", draft([{ text: "One", weight: 1.5 }], { duration: [30] })],
    ["a share of zero", draft([{ text: "One", weight: 0 }], { duration: [30] })],
    ["a share past the ceiling", draft([{ text: "One", weight: MAX_WEIGHT + 1 }], { duration: [30] })],
    [
      "a poster pointing past the last beat",
      draft([{ text: "One", weight: 1 }], { duration: [30], timeline: { beats: [{ key: 1, text: "One", weight: 1 }], transition: "fade", keyBeat: 4 } }),
    ],
    [
      "a beat too brief to read on the shortest clip",
      draft([{ text: "Long", weight: 20 }, { text: "Blink", weight: 1 }], { duration: [6] }),
    ],
    [
      "the same beats, comfortable on a longer clip",
      draft([{ text: "Long", weight: 20 }, { text: "Blink", weight: 1 }], { duration: [30] }),
    ],
    [
      "the shortest clip in a wide axis is the one that decides",
      draft([{ text: "Long", weight: 20 }, { text: "Blink", weight: 1 }], { duration: [30, 6, 12] }),
    ],
    [
      "an empty duration axis reads as the single default",
      draft([{ text: "Long", weight: 20 }, { text: "Blink", weight: 1 }], { duration: [] }),
    ],
  ];

  test.each(cases)("%s — the editor and the domain reach the same verdict", (_name, state) => {
    expect(flagged(state)).toBe(refused(state));
  });

  test("an empty beat list is NOT a timeline, and is nobody's error", () => {
    // The one place the two deliberately differ, and it is not drift. `timelineProblem`
    // refuses an empty `beats` array — but the editor never sends one: `toBrief` omits
    // `copy.timeline` entirely while the list is empty, so there is nothing to judge.
    const empty = draft([]);
    expect(toBrief(empty).copy?.timeline).toBeUndefined();
    expect(flagged(empty)).toBe(false);
  });

  test("the boundary case is not wrongly flagged: three equal beats at exactly the floor", () => {
    // 3 × MIN_DWELL_SEC is 3.5999999999999996, so a naive comparison rejects a draft that
    // sits exactly on the floor. The editor imports the domain's own tolerance.
    const state = draft(
      [
        { text: "One", weight: 1 },
        { text: "Two", weight: 1 },
        { text: "Three", weight: 1 },
      ],
      { duration: [MIN_DWELL_SEC * 3] },
    );
    expect(refused(state)).toBe(false);
    expect(flagged(state)).toBe(false);
  });
});

describe("validateTimeline speaks the editor's language, not the parser's", () => {
  test("an under-floor beat is named by its position, its seconds and the clip", () => {
    const state = draft([{ text: "Long", weight: 20 }, { text: "Blink", weight: 1 }], { duration: [6] });
    const errors = validateTimeline(state);
    const dwellSec = (6 * 1) / 21;
    expect(errors["copy-timeline-beat-1"]).toBe(
      messages.timelineBeatUnderFloor(2, dwellSec, MIN_DWELL_SEC, 6),
    );
    // And not the domain's own field-path wording.
    expect(errors["copy-timeline-beat-1"]).not.toMatch(/copy\.timeline/);
  });

  test("an over-long sequence and a stranded poster each get their own sentence", () => {
    const tooMany = draft(
      Array.from({ length: MAX_BEATS + 1 }, (_, i) => ({ text: `B${i}`, weight: 1 })),
      { duration: [30] },
    );
    expect(validateTimeline(tooMany)["copy-timeline"]).toBe(messages.timelineTooManyBeats(MAX_BEATS));

    const stranded = draft([{ text: "One", weight: 1 }], {
      duration: [30],
      timeline: { beats: [{ key: 1, text: "One", weight: 1 }], transition: "fade", keyBeat: 4 },
    });
    expect(validateTimeline(stranded)["copy-timeline"]).toBe(messages.timelineKeyBeatMissing);
  });

  test("the errors land under a key the Copy section counts", () => {
    const state = draft([{ text: "Long", weight: 20 }, { text: "Blink", weight: 1 }], { duration: [6] });
    // CopySection counts keys starting with "copy"; a key it cannot see is an error nobody reads.
    expect(Object.keys(validateTimeline(state)).every((key) => key.startsWith("copy"))).toBe(true);
  });
});
