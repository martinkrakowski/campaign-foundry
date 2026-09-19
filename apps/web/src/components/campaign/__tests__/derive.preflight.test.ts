import { describe, test, expect } from "vitest";
import { preflightFigures } from "../derive";
import * as messages from "../messages";
import { editorReducer, initialEditorState, type EditorState } from "../editor-state";

const classic = (): EditorState => {
  let state = initialEditorState("brief");
  state = editorReducer(state, {
    type: "setProduct",
    key: state.products[0]!.key,
    patch: { id: "alpha", name: "A" },
  });
  return state;
};

describe("preflightFigures (SG8)", () => {
  test("a classic brief answers from classicAdCount, with no planner involved", () => {
    const figures = preflightFigures(classic(), null);
    expect(figures).not.toBeNull();
    // The count is the estimate's own derivation, not a second one: products ×
    // every canonical ratio × treatments, plus each requested display size.
    expect(figures!.creatives).toBeGreaterThan(0);
  });

  test("a Randomized brief with no plan answers null — never a zero", () => {
    // A zero is a claim about the run. "Unknown" is not, and the confirm says
    // where the number lives instead.
    expect(preflightFigures(initialEditorState("variation"), null)).toBeNull();
  });

  test("a Randomized brief reads the planner's number when one is given", () => {
    const figures = preflightFigures(initialEditorState("variation"), { creatives: 12 });
    expect(figures?.creatives).toBe(12);
  });

  test("a classic brief with no identified product answers null", () => {
    expect(preflightFigures(initialEditorState("brief"), null)).toBeNull();
  });

  /**
   * The layer count is what a RUN composes, not what is authored: the generator
   * gathers `enabled !== false` (HL4), so a disabled layer is not a deliverable
   * and must not be promised as one.
   */
  test("layers counts what the run composes, not what is authored", () => {
    const base = classic();
    const layers = base.template.layers;
    const withDisabled: EditorState = {
      ...base,
      template: {
        ...base.template,
        layers: layers.map((layer, i) => (i === 0 ? { ...layer, enabled: false } : layer)),
      },
    };
    const before = preflightFigures(base, null)!.layers;
    const after = preflightFigures(withDisabled, null)!.layers;
    expect(after).toBe(before - 1);
  });

  test("platforms are the brief's own list, passed through", () => {
    const state = { ...classic(), platforms: ["instagram-feed", "instagram-reel"] };
    expect(preflightFigures(state, null)?.platforms).toEqual(["instagram-feed", "instagram-reel"]);
  });
});

describe("generatePreflight's wording (SG8)", () => {
  test("singular forms when the run makes one of each", () => {
    expect(messages.generatePreflight({ creatives: 1, layers: 1, platforms: ["x"] })).toBe(
      "1 creative · 1 layer · x",
    );
  });

  test("plural forms otherwise", () => {
    expect(messages.generatePreflight({ creatives: 12, layers: 4, platforms: ["a", "b"] })).toBe(
      "12 creatives · 4 layers · a, b",
    );
  });

  /**
   * An empty platform list is said out loud rather than rendered as a trailing
   * separator with nothing after it. The draft is refusable for other reasons;
   * the sentence's job is to be readable either way.
   */
  test("no platforms selected is stated, not left blank", () => {
    expect(messages.generatePreflight({ creatives: 2, layers: 1, platforms: [] })).toContain(
      "no platforms selected",
    );
  });
});
