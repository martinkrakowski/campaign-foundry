import { describe, test, expect } from "vitest";
import { previewDockProps } from "../preview-props";
import { initialEditorState, emptyProduct, STATIC_PLATFORMS } from "../editor-state";

/**
 * The state→dock mapping's own contract (D45): mode-aware look, real motion, the
 * projection's output rule for the platform, and the wizard step readout. The
 * fabrication guard proves the words stay sanctioned; these tests pin the wiring.
 */

describe("previewDockProps", () => {
  test("a randomized draft takes the look from the first value of each axis", () => {
    const state = initialEditorState("variation");
    state.products = [emptyProduct(1, "#1473E6")];
    state.variation.layout = ["headline-bottom", "headline-top"];
    state.variation.tone = ["subtle", "bold"];
    const props = previewDockProps(state, 2, 6)!;
    expect(props.layout).toBe("headline-bottom");
    expect(props.tone).toBe("subtle");
  });

  test("the anchor is passed only while the saved brief will carry the axis (T4)", () => {
    const state = initialEditorState("variation");
    state.products = [emptyProduct(1, "#1473E6")];
    // The derived top/bottom pair means the axis is ABSENT: the dock derives
    // the placement from layout, exactly as the compositor does.
    expect(previewDockProps(state, 0, 6)!.anchor).toBeUndefined();
    // Selecting Middle makes the axis real, and the first value feeds the dock.
    state.variation.anchor = ["middle", "top"];
    state.anchorExplicit = true;
    expect(previewDockProps(state, 0, 6)!.anchor).toBe("middle");
    // A classic draft never reads the axis, whatever its treatments say.
    const classic = initialEditorState("brief");
    classic.products = [emptyProduct(1, "#1473E6")];
    classic.variation.anchor = ["middle"];
    classic.anchorExplicit = true;
    expect(previewDockProps(classic, 0, 6)!.anchor).toBeUndefined();
  });

  test("a classic draft takes the look from its treatment, never its leftover axes", () => {
    const state = initialEditorState("brief");
    state.products = [emptyProduct(1, "#1473E6")];
    state.treatments = [{ id: "bold-hero", layout: "headline-bottom", tone: "subtle" }];
    // A visit to Randomized leaves axes behind; the projection drops them, so the dock must too.
    state.variation.layout = ["headline-top"];
    state.variation.tone = ["bold"];
    const props = previewDockProps(state, 0, 6)!;
    expect(props.layout).toBe("headline-bottom");
    expect(props.tone).toBe("subtle");
  });

  test("a classic draft with no treatment draws the renderer's default, axes or not", () => {
    const state = initialEditorState("brief");
    state.products = [emptyProduct(1, "#1473E6")];
    state.variation.layout = ["headline-bottom"];
    state.variation.tone = ["subtle"];
    const props = previewDockProps(state, 0, 6)!;
    expect(props.layout).toBeUndefined();
    expect(props.tone).toBeUndefined();
  });

  test("motion is real: the first picked kind, only for video in a randomized draft", () => {
    const state = initialEditorState("variation");
    state.products = [emptyProduct(1, "#1473E6")];
    state.formats = ["static", "motion"];
    state.motion = ["ken-burns-in", "headline-rise"];
    expect(previewDockProps(state, 0, 6)!.motion).toBe("ken-burns-in");
    // Video asked for but no kind picked yet — the readout shows a still, not a guess.
    state.motion = [];
    expect(previewDockProps(state, 0, 6)!.motion).toBeUndefined();
    // A classic draft never reads the motion axis, whatever it still carries.
    const classic = initialEditorState("brief");
    classic.products = [emptyProduct(1, "#1473E6")];
    classic.formats = ["static", "motion"];
    classic.motion = ["ken-burns-in"];
    expect(previewDockProps(classic, 0, 6)!.motion).toBeUndefined();
  });

  test("the platform comes from the draft's own output, as the projection emits it", () => {
    const state = initialEditorState("variation");
    state.products = [emptyProduct(1, "#1473E6")];
    // The default static output is the absent-key case: the projection omits it, so
    // the caption reads "no platform yet" exactly as the Review figure's does.
    expect(previewDockProps(state, 0, 6)!.platformId).toBeUndefined();
    // A declared-but-default output survives the projection, and its platforms with it.
    state.outputExplicit = true;
    expect(previewDockProps(state, 0, 6)!.platformId).toBe(STATIC_PLATFORMS[0]);
    // A diverging output is emitted, and its first platform names the caption.
    state.outputExplicit = false;
    state.platforms = ["instagram-story", "tiktok"];
    expect(previewDockProps(state, 0, 6)!.platformId).toBe("instagram-story");
  });

  test("the step readout is the walk's cursor, one-based, and the count is the walk's length", () => {
    const state = initialEditorState("brief");
    state.products = [emptyProduct(1, "#1473E6")];
    const props = previewDockProps(state, 4, 6)!;
    expect(props.step).toBe(5);
    expect(props.stepCount).toBe(6);
  });

  test("a draft with no product derives no dock — nothing to draw, nothing invented", () => {
    const state = initialEditorState("variation");
    state.products = [];
    expect(previewDockProps(state, 0, 6)).toBeNull();
  });

  test("the style is carried exactly as toBrief will emit it (T5/D45)", () => {
    const state = initialEditorState("variation");
    state.products = [emptyProduct(1, "#1473E6")];
    // A style-less draft: the absent key — the dock resolves the defaults itself.
    expect(previewDockProps(state, 0, 6)!.style).toBeUndefined();
    // A declared style rides to the dock, so it cannot show a typography the
    // saved brief would not carry.
    state.style = { fontFamily: "Lora", align: "left" };
    state.styleExplicit = true;
    expect(previewDockProps(state, 0, 6)!.style).toEqual({ fontFamily: "Lora", align: "left" });
    // The same derivation toBrief uses decides — a diverging draft without the
    // flag is emitted here too.
    state.styleExplicit = false;
    expect(previewDockProps(state, 0, 6)!.style).toEqual({ fontFamily: "Lora", align: "left" });
  });
});
