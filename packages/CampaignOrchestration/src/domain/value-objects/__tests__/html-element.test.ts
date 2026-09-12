import { describe, test, expect } from "vitest";
import type { LayerKind } from "../layer-kinds.js";
import {
  HTML_ELEMENT_KINDS,
  layerElementsProblem,
  type Frame,
} from "../html-element.js";

/** The valid frame fixture every accept case starts from. */
const frame: Frame = { x: 0.1, y: 0.2, w: 0.5, h: 0.3, anchor: "top" };

describe("layerElementsProblem (HL1)", () => {
  test("declares text, button and image as the whole element vocabulary (HL-D2)", () => {
    expect(HTML_ELEMENT_KINDS).toEqual(["text", "button", "image"]);
  });

  test("absent elements are always fine", () => {
    expect(layerElementsProblem("html", undefined)).toBeUndefined();
  });

  test("an html layer with no elements is legal — the canonical layer holds an empty list", () => {
    expect(layerElementsProblem("html", [])).toBeUndefined();
  });

  test("accepts each kind's own fields", () => {
    expect(
      layerElementsProblem("html", [{ kind: "text", text: "Buy now", frame }]),
    ).toBeUndefined();
    expect(
      layerElementsProblem("html", [
        { kind: "button", text: "Shop", frame: { ...frame, anchor: "middle" } },
      ]),
    ).toBeUndefined();
    // An image carries no copy at all: `frame` alone is its whole contract.
    expect(
      layerElementsProblem("html", [{ kind: "image", frame }]),
    ).toBeUndefined();
  });

  test("accepts every anchor the vocabulary names, and 0/1 fractions", () => {
    for (const anchor of ["top", "middle", "bottom"] as const) {
      expect(
        layerElementsProblem("html", [
          { kind: "text", text: "x", frame: { x: 0, y: 1, w: 0, h: 1, anchor } },
        ]),
      ).toBeUndefined();
    }
  });

  test("refuses elements on any other layer kind — the empty list included", () => {
    const value = [{ kind: "image", frame }];
    expect(layerElementsProblem("image", value)).toEqual({
      path: "",
      must: 'be absent for layer kind "image"',
      value,
    });
    expect(layerElementsProblem("shade", [])).toEqual({
      path: "",
      must: 'be absent for layer kind "shade"',
      value: [],
    });
    // The shared decision's own contract, exercised directly: the entry guard
    // checks the kind before reaching it, so nothing else covers this branch.
    expect(layerElementsProblem("bogus" as LayerKind, {})).toEqual({
      path: "",
      must: 'be absent for layer kind "bogus"',
      value: {},
    });
  });

  test("refuses elements that are not an array", () => {
    for (const value of ["nope", 5, {}, null, true]) {
      expect(layerElementsProblem("html", value)).toEqual({
        path: "",
        must: "be an array of elements",
        value,
      });
    }
  });

  test("refuses a list entry that is not an element object", () => {
    for (const entry of [null, "junk", 42, true, []]) {
      expect(layerElementsProblem("html", [entry])).toEqual({
        path: "[0]",
        must: "be an object",
        value: entry,
      });
    }
  });

  test("refuses an unknown element kind, or a missing one", () => {
    for (const kind of [undefined, "link", "layer", 5]) {
      expect(layerElementsProblem("html", [{ kind, frame }])).toEqual({
        path: "[0].kind",
        must: 'be one of "text", "button", "image"',
        value: kind,
      });
    }
  });

  test("refuses a field the element's kind does not carry", () => {
    // An image may not carry copy: the field table refuses it, not a special case.
    expect(
      layerElementsProblem("html", [{ kind: "image", text: "buy", frame }]),
    ).toEqual({
      path: "[0].text",
      must: 'be one of "kind", "frame" for element kind "image"',
      value: "buy",
    });
    expect(
      layerElementsProblem("html", [{ kind: "text", text: "x", style: {}, frame }]),
    ).toEqual({
      path: "[0].style",
      must: 'be one of "kind", "text", "frame" for element kind "text"',
      value: {},
    });
  });

  test("refuses copy that is not a string", () => {
    for (const text of [5, null, {}, ["x"]]) {
      expect(
        layerElementsProblem("html", [{ kind: "text", text, frame }]),
      ).toEqual({ path: "[0].text", must: "be a string", value: text });
    }
  });

  test("refuses a frame that is not an object", () => {
    for (const value of [undefined, null, "frame", 5, []]) {
      expect(
        layerElementsProblem("html", [{ kind: "text", text: "x", frame: value }]),
      ).toEqual({ path: "[0].frame", must: "be an object", value });
    }
  });

  test("refuses a frame field D130 does not name", () => {
    expect(
      layerElementsProblem("html", [
        { kind: "text", text: "x", frame: { ...frame, z: 1 } },
      ]),
    ).toEqual({
      path: "[0].frame.z",
      must: 'be one of "x", "y", "w", "h", "anchor"',
      value: 1,
    });
  });

  test.each([
    ["x", "a string", "0.5"],
    ["y", "1.4 above the range", 1.4],
    ["w", "-0.1 below the range", -0.1],
    ["h", "NaN", Number.NaN],
    ["h", "infinity", Number.POSITIVE_INFINITY],
  ])("refuses a frame %s that is %s", (field, _label, value) => {
    expect(
      layerElementsProblem("html", [
        { kind: "text", text: "x", frame: { ...frame, [field]: value } },
      ]),
    ).toEqual({
      path: `[0].frame.${field}`,
      must: "be a number in [0, 1]",
      value,
    });
  });

  test("refuses a frame missing a required fraction, reporting the absent value", () => {
    const withoutW = {
      x: frame.x,
      y: frame.y,
      h: frame.h,
      anchor: frame.anchor,
    };
    expect(
      layerElementsProblem("html", [
        { kind: "text", text: "x", frame: withoutW },
      ]),
    ).toEqual({ path: "[0].frame.w", must: "be a number in [0, 1]", value: undefined });
  });

  test("refuses an anchor outside the vocabulary, or a missing one", () => {
    for (const anchor of [undefined, "sideways", 5, null]) {
      expect(
        layerElementsProblem("html", [
          { kind: "text", text: "x", frame: { ...frame, anchor } },
        ]),
      ).toEqual({
        path: "[0].frame.anchor",
        must: 'be one of "top", "middle", "bottom"',
        value: anchor,
      });
    }
  });

  test("names the offending entry by its index in the list", () => {
    const problem = layerElementsProblem("html", [
      { kind: "text", text: "ok", frame },
      { kind: "text", text: 5, frame },
    ]);
    expect(problem).toEqual({
      path: "[1].text",
      must: "be a string",
      value: 5,
    });
  });
});
