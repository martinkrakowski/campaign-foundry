import { describe, test, expect } from "vitest";
import {
  CANONICAL_TEMPLATES,
  type CreativeTemplateLayer,
} from "@campaignfoundry/CampaignOrchestration/creative-templates";
import {
  layerElementsProblem,
  type Frame,
  type HtmlElement,
} from "@campaignfoundry/CampaignOrchestration/html-element";
import type { BriefTemplate } from "@campaignfoundry/CampaignOrchestration/brief-template";
import {
  editorReducer,
  initialEditorState,
  valuesEqual,
  type EditorAction,
  type EditorState,
} from "../editor-state";
import * as messages from "../messages";

/**
 * HL5a — the `html` layer's elements: add, remove, reorder, copy and frame.
 *
 * The contract these tests pin: every action addresses a layer by id and is a
 * no-op — the SAME state object — when the layer is missing, is not of kind
 * `html`, or the index is outside the list; an `image` element never carries
 * copy; a frame value is clamped into [0, 1] or refused; and the canonical form
 * deletes the `elements` key when the list empties, so an add-then-remove is
 * `valuesEqual` to the template that was loaded. The last test is the one that
 * matters most: after any sequence of these actions, every layer still
 * satisfies the domain's own `layerElementsProblem` — the editor never produces
 * what the boundary refuses.
 */

const CANONICAL = CANONICAL_TEMPLATES["image-html"];

/**
 * The canonical `image-html` template, materialised: image, html, logo. No
 * campaign type seeds it — D120's presets name the three social types — so the
 * pinned id is the library's own, spelled out rather than derived.
 */
const htmlTemplate = (): BriefTemplate => ({
  id: "canonical-image-html",
  version: CANONICAL.version,
  creativeType: CANONICAL.creativeType,
  unit: CANONICAL.unit,
  layers: CANONICAL.layers,
});

/** A draft pinned to the canonical `image-html` template. */
const htmlState = (): EditorState => ({
  ...initialEditorState(),
  template: htmlTemplate(),
});

const reduce = (state: EditorState, ...actions: EditorAction[]): EditorState =>
  actions.reduce(editorReducer, state);

const htmlLayer = (state: EditorState): CreativeTemplateLayer =>
  state.template.layers.find((layer) => layer.id === "html")!;

const elementsOf = (state: EditorState): readonly HtmlElement[] =>
  htmlLayer(state).elements ?? [];

/** One element of each kind, in the order added. */
const withThree = (state = htmlState()): EditorState =>
  reduce(
    state,
    { type: "addHtmlElement", layerId: "html", kind: "text" },
    { type: "addHtmlElement", layerId: "html", kind: "button" },
    { type: "addHtmlElement", layerId: "html", kind: "image" },
  );

describe("addHtmlElement (HL5a)", () => {
  test("appends a text element carrying the catalog's copy and a frame in [0, 1]", () => {
    const next = editorReducer(htmlState(), {
      type: "addHtmlElement",
      layerId: "html",
      kind: "text",
    });
    const elements = elementsOf(next);
    expect(elements).toHaveLength(1);
    expect(elements[0]!.kind).toBe("text");
    expect(elements[0]!.text).toBe(messages.htmlElementDefaultCopy("text"));
    expect(layerElementsProblem("html", elements)).toBeUndefined();
    // The frame is the one the reducer chose, not one the caller passed: every
    // value is a fraction of the canvas (D130).
    for (const field of ["x", "y", "w", "h"] as const) {
      expect(elements[0]!.frame[field]).toBeGreaterThanOrEqual(0);
      expect(elements[0]!.frame[field]).toBeLessThanOrEqual(1);
    }
  });

  test("a button starts with the button's copy; an image carries no text at all", () => {
    const button = editorReducer(htmlState(), {
      type: "addHtmlElement",
      layerId: "html",
      kind: "button",
    });
    expect(elementsOf(button)[0]!.text).toBe(
      messages.htmlElementDefaultCopy("button"),
    );
    const image = editorReducer(htmlState(), {
      type: "addHtmlElement",
      layerId: "html",
      kind: "image",
    });
    const element = elementsOf(image)[0]!;
    expect(element.kind).toBe("image");
    // The domain's field table refuses copy on an image, so the editor never
    // writes the key — not even an empty string.
    expect(element.text).toBeUndefined();
    expect("text" in element).toBe(false);
  });

  test("a second add appends, and the first element is untouched", () => {
    const next = reduce(htmlState(), {
      type: "addHtmlElement",
      layerId: "html",
      kind: "text",
    }, {
      type: "addHtmlElement",
      layerId: "html",
      kind: "image",
    });
    expect(elementsOf(next).map((element) => element.kind)).toEqual([
      "text",
      "image",
    ]);
    expect(elementsOf(next)[0]!.text).toBe(
      messages.htmlElementDefaultCopy("text"),
    );
  });

  test("a missing layer, a layer of another kind, and a fresh draft are all no-ops", () => {
    const base = htmlState();
    expect(
      editorReducer(base, {
        type: "addHtmlElement",
        layerId: "no-such-layer",
        kind: "text",
      }),
    ).toBe(base);
    // `image` is a layer of the same template, and it is not an `html` layer —
    // only that kind carries elements (HL-D1).
    expect(
      editorReducer(base, {
        type: "addHtmlElement",
        layerId: "image",
        kind: "text",
      }),
    ).toBe(base);
    // A draft no campaign type seeds with an html layer holds none.
    const plain = initialEditorState();
    expect(
      editorReducer(plain, {
        type: "addHtmlElement",
        layerId: "html",
        kind: "text",
      }),
    ).toBe(plain);
  });
});

describe("removeHtmlElement (HL5a)", () => {
  test("removes exactly that element and leaves the order of the rest alone", () => {
    const next = editorReducer(withThree(), {
      type: "removeHtmlElement",
      layerId: "html",
      index: 1,
    });
    expect(elementsOf(next).map((element) => element.kind)).toEqual([
      "text",
      "image",
    ]);
  });

  test("removing the last element deletes the key, so add-then-remove is valuesEqual to the loaded template", () => {
    // The round-trip lesson from M3's review: an empty list left behind is a
    // template a loaded brief would never have carried, and a saved brief then
    // reads as dirty for a change the user undid.
    const added = editorReducer(htmlState(), {
      type: "addHtmlElement",
      layerId: "html",
      kind: "text",
    });
    const removed = editorReducer(added, {
      type: "removeHtmlElement",
      layerId: "html",
      index: 0,
    });
    expect(removed.template.layers[1]).toStrictEqual({
      id: "html",
      kind: "html",
    });
    expect("elements" in htmlLayer(removed)).toBe(false);
    expect(valuesEqual(removed.template, htmlState().template)).toBe(true);
  });

  test("add two, remove two: the key is gone and the template is the one loaded", () => {
    const next = reduce(
      withThree(),
      { type: "removeHtmlElement", layerId: "html", index: 2 },
      { type: "removeHtmlElement", layerId: "html", index: 1 },
      { type: "removeHtmlElement", layerId: "html", index: 0 },
    );
    expect(valuesEqual(next.template, htmlState().template)).toBe(true);
  });

  test("an out-of-range index, a non-integer index, and a foreign layer are no-ops", () => {
    const base = withThree();
    expect(
      editorReducer(base, {
        type: "removeHtmlElement",
        layerId: "html",
        index: 3,
      }),
    ).toBe(base);
    expect(
      editorReducer(base, {
        type: "removeHtmlElement",
        layerId: "html",
        index: -1,
      }),
    ).toBe(base);
    expect(
      editorReducer(base, {
        type: "removeHtmlElement",
        layerId: "html",
        index: 0.5,
      }),
    ).toBe(base);
    expect(
      editorReducer(base, {
        type: "removeHtmlElement",
        layerId: "logo",
        index: 0,
      }),
    ).toBe(base);
    // An html layer that holds no elements has nothing at index 0 to remove.
    const empty = htmlState();
    expect(
      editorReducer(empty, {
        type: "removeHtmlElement",
        layerId: "html",
        index: 0,
      }),
    ).toBe(empty);
  });
});

describe("moveHtmlElement (HL5a)", () => {
  test("re-points one element and leaves every other one in place", () => {
    const base = withThree();
    const next = editorReducer(base, {
      type: "moveHtmlElement",
      layerId: "html",
      from: 2,
      to: 0,
    });
    expect(elementsOf(next).map((element) => element.kind)).toEqual([
      "image",
      "text",
      "button",
    ]);
    // The moved element is the same object, never a copy.
    expect(elementsOf(next)[0]).toBe(elementsOf(base)[2]);
    // And back: the move is its own inverse.
    const restored = editorReducer(next, {
      type: "moveHtmlElement",
      layerId: "html",
      from: 0,
      to: 2,
    });
    expect(valuesEqual(restored.template, base.template)).toBe(true);
  });

  test("moving onto its own index, out of range, or on a foreign layer is a no-op", () => {
    const base = withThree();
    expect(
      editorReducer(base, {
        type: "moveHtmlElement",
        layerId: "html",
        from: 1,
        to: 1,
      }),
    ).toBe(base);
    expect(
      editorReducer(base, {
        type: "moveHtmlElement",
        layerId: "html",
        from: 0,
        to: 3,
      }),
    ).toBe(base);
    expect(
      editorReducer(base, {
        type: "moveHtmlElement",
        layerId: "html",
        from: 3,
        to: 0,
      }),
    ).toBe(base);
    expect(
      editorReducer(base, {
        type: "moveHtmlElement",
        layerId: "html",
        from: 0,
        to: -1,
      }),
    ).toBe(base);
    expect(
      editorReducer(base, {
        type: "moveHtmlElement",
        layerId: "image",
        from: 0,
        to: 1,
      }),
    ).toBe(base);
  });
});

describe("setHtmlElementText (HL5a)", () => {
  test("sets the copy on a text and on a button element", () => {
    const base = withThree();
    const typed = editorReducer(base, {
      type: "setHtmlElementText",
      layerId: "html",
      index: 0,
      text: "Stay wild.",
    });
    expect(elementsOf(typed)[0]!.text).toBe("Stay wild.");
    const button = editorReducer(typed, {
      type: "setHtmlElementText",
      layerId: "html",
      index: 1,
      text: "Shop now",
    });
    expect(elementsOf(button)[1]!.text).toBe("Shop now");
    // Nobody else's copy moved.
    expect(elementsOf(button)[2]!.kind).toBe("image");
  });

  test("an image element carries no copy, so setting text on one is a no-op", () => {
    const base = withThree();
    expect(
      editorReducer(base, {
        type: "setHtmlElementText",
        layerId: "html",
        index: 2,
        text: "alt text",
      }),
    ).toBe(base);
  });

  test("an out-of-range index and a foreign layer are no-ops", () => {
    const base = withThree();
    expect(
      editorReducer(base, {
        type: "setHtmlElementText",
        layerId: "html",
        index: 3,
        text: "x",
      }),
    ).toBe(base);
    expect(
      editorReducer(base, {
        type: "setHtmlElementText",
        layerId: "logo",
        index: 0,
        text: "x",
      }),
    ).toBe(base);
  });
});

describe("setHtmlElementFrame (HL5a)", () => {
  test("sets a frame value inside [0, 1]", () => {
    const next = editorReducer(withThree(), {
      type: "setHtmlElementFrame",
      layerId: "html",
      index: 0,
      patch: { x: 0.25 },
    });
    expect(elementsOf(next)[0]!.frame.x).toBe(0.25);
    // Only the field named moved.
    expect(elementsOf(next)[0]!.frame.y).toBe(
      elementsOf(withThree())[0]!.frame.y,
    );
  });

  test("clamps a value outside [0, 1] to the nearer end", () => {
    const base = withThree();
    const wide = editorReducer(base, {
      type: "setHtmlElementFrame",
      layerId: "html",
      index: 0,
      patch: { w: 4 },
    });
    expect(elementsOf(wide)[0]!.frame.w).toBe(1);
    const negative = editorReducer(wide, {
      type: "setHtmlElementFrame",
      layerId: "html",
      index: 0,
      patch: { y: -0.5 },
    });
    expect(elementsOf(negative)[0]!.frame.y).toBe(0);
    // The clamped frame is one the domain accepts — the point of the clamp.
    expect(layerElementsProblem("html", elementsOf(negative))).toBeUndefined();
  });

  test("refuses a value that is not a finite number, keeping the one it had", () => {
    const base = withThree();
    const before = elementsOf(base)[0]!.frame;
    const notANumber = editorReducer(base, {
      type: "setHtmlElementFrame",
      layerId: "html",
      index: 0,
      patch: { x: Number.NaN },
    });
    expect(elementsOf(notANumber)[0]!.frame.x).toBe(before.x);
    const infinite = editorReducer(base, {
      type: "setHtmlElementFrame",
      layerId: "html",
      index: 0,
      patch: { h: Number.POSITIVE_INFINITY },
    });
    expect(elementsOf(infinite)[0]!.frame.h).toBe(before.h);
    // A hand-restored draft reaches the reducer as `unknown`, so a string is
    // refused the same way — the reducer is the contract, not the input's type.
    const asString = editorReducer(base, {
      type: "setHtmlElementFrame",
      layerId: "html",
      index: 0,
      patch: { x: "0.5" } as unknown as Partial<Frame>,
    });
    expect(elementsOf(asString)[0]!.frame.x).toBe(before.x);
  });

  test("accepts an anchor inside the vocabulary and refuses one outside it", () => {
    const base = withThree();
    const middle = editorReducer(base, {
      type: "setHtmlElementFrame",
      layerId: "html",
      index: 0,
      patch: { anchor: "middle" },
    });
    expect(elementsOf(middle)[0]!.frame.anchor).toBe("middle");
    expect(
      editorReducer(middle, {
        type: "setHtmlElementFrame",
        layerId: "html",
        index: 0,
        patch: { anchor: "sideways" } as unknown as Partial<Frame>,
      }),
    ).toBe(middle);
  });

  test("a patch the frame already satisfies is a no-op", () => {
    // No edit, so no history entry either — the `setLayerEnabled` rule.
    const base = withThree();
    const frame = elementsOf(base)[0]!.frame;
    expect(
      editorReducer(base, {
        type: "setHtmlElementFrame",
        layerId: "html",
        index: 0,
        patch: { x: frame.x, y: frame.y, w: frame.w, h: frame.h },
      }),
    ).toBe(base);
    expect(
      editorReducer(base, {
        type: "setHtmlElementFrame",
        layerId: "html",
        index: 0,
        patch: {},
      }),
    ).toBe(base);
  });

  test("an out-of-range index and a foreign layer are no-ops", () => {
    const base = withThree();
    expect(
      editorReducer(base, {
        type: "setHtmlElementFrame",
        layerId: "html",
        index: 3,
        patch: { x: 0.5 },
      }),
    ).toBe(base);
    expect(
      editorReducer(base, {
        type: "setHtmlElementFrame",
        layerId: "image",
        index: 0,
        patch: { x: 0.5 },
      }),
    ).toBe(base);
  });
});

describe("the invariant (HL5a)", () => {
  test("after any sequence of element actions, every layer still satisfies layerElementsProblem", () => {
    // The editor must never hand the boundary a template it refuses. Every
    // branch above is legal here — including the ones the reducer declines —
    // so the script walks all five actions, the refused shapes included.
    const script: EditorAction[] = [
      { type: "addHtmlElement", layerId: "html", kind: "text" },
      { type: "addHtmlElement", layerId: "html", kind: "button" },
      { type: "addHtmlElement", layerId: "html", kind: "image" },
      { type: "setHtmlElementText", layerId: "html", index: 1, text: "Shop" },
      { type: "setHtmlElementFrame", layerId: "html", index: 0, patch: { x: 9 } },
      { type: "setHtmlElementFrame", layerId: "html", index: 0, patch: { y: -9 } },
      {
        type: "setHtmlElementFrame",
        layerId: "html",
        index: 2,
        patch: { anchor: "middle" },
      },
      { type: "moveHtmlElement", layerId: "html", from: 2, to: 0 },
      { type: "setHtmlElementText", layerId: "html", index: 0, text: "" },
      { type: "removeHtmlElement", layerId: "html", index: 1 },
      { type: "moveHtmlElement", layerId: "html", from: 0, to: 1 },
      { type: "removeHtmlElement", layerId: "html", index: 9 },
      { type: "removeHtmlElement", layerId: "html", index: 0 },
      { type: "removeHtmlElement", layerId: "html", index: 0 },
    ];
    let state = htmlState();
    for (const action of script) {
      state = editorReducer(state, action);
      for (const layer of state.template.layers) {
        expect(
          layerElementsProblem(layer.kind, layer.elements),
          `${action.type} → ${layer.id}`,
        ).toBeUndefined();
      }
    }
    // The script ends where it began: an html layer with no elements at all.
    expect(valuesEqual(state.template, htmlState().template)).toBe(true);
  });
});
