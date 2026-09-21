import { describe, expect, test } from "vitest";
import { CANONICAL_TEMPLATES } from "../creative-templates.js";
import {
  CREATIVE_GEOMETRY,
  FULL_CANVAS_RECT,
  LAYER_KIND_DEFAULT_RECTS,
  defaultLayerRect,
  resolveLayerFrame,
  type LayerFrame,
} from "../creative-geometry.js";
import { LAYER_KINDS } from "../layer-kinds.js";

const BASE: LayerFrame = { x: 0, y: 0, w: 1, h: 0.5, anchor: "top" };

describe("LAYER_KIND_DEFAULT_RECTS (D130)", () => {
  test("every layer kind has a default rect", () => {
    expect(Object.keys(LAYER_KIND_DEFAULT_RECTS).sort()).toEqual([...LAYER_KINDS].sort());
  });

  test("grounds and full-canvas kinds are FULL_CANVAS_RECT, extracted not invented", () => {
    expect(defaultLayerRect("image")).toEqual(FULL_CANVAS_RECT);
    expect(defaultLayerRect("video")).toEqual(FULL_CANVAS_RECT);
    expect(defaultLayerRect("shade")).toEqual(FULL_CANVAS_RECT);
    expect(defaultLayerRect("fill")).toEqual(FULL_CANVAS_RECT);
    expect(defaultLayerRect("html")).toEqual(FULL_CANVAS_RECT);
    expect(FULL_CANVAS_RECT).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  test("accent, logo and text defaults equal CREATIVE_GEOMETRY's fractions verbatim", () => {
    expect(LAYER_KIND_DEFAULT_RECTS.accent).toEqual({
      x: 0,
      y: 1 - CREATIVE_GEOMETRY.accentSolidHeightFraction,
      w: 1,
      h: CREATIVE_GEOMETRY.accentSolidHeightFraction,
    });
    expect(LAYER_KIND_DEFAULT_RECTS.logo).toEqual({
      x: 1 - CREATIVE_GEOMETRY.logoWidthFraction - CREATIVE_GEOMETRY.logoMarginFraction,
      y: CREATIVE_GEOMETRY.logoMarginFraction,
      w: CREATIVE_GEOMETRY.logoWidthFraction,
      h: CREATIVE_GEOMETRY.logoWidthFraction,
    });
    const text = {
      x: 0,
      y: CREATIVE_GEOMETRY.headlineAnchor.top,
      w: 1,
      h: 1 - CREATIVE_GEOMETRY.headlineAnchor.top - CREATIVE_GEOMETRY.headlineAnchor.bottom,
    };
    expect(LAYER_KIND_DEFAULT_RECTS["static-text"]).toEqual(text);
    expect(LAYER_KIND_DEFAULT_RECTS["animated-text"]).toEqual(text);
  });

  test("canonical template layer frames, when defaulted, equal those rects", () => {
    for (const template of Object.values(CANONICAL_TEMPLATES)) {
      for (const layer of template.layers) {
        expect(layer).not.toHaveProperty("frame");
        expect(defaultLayerRect(layer.kind)).toEqual(LAYER_KIND_DEFAULT_RECTS[layer.kind]);
      }
    }
  });
});

describe("resolveLayerFrame (D130)", () => {
  test("absent frame is undefined — today's geometry, not a defaulted rect", () => {
    expect(resolveLayerFrame(undefined, { ratio: "1:1" })).toBeUndefined();
    expect(resolveLayerFrame(undefined, { size: "300x250" })).toBeUndefined();
  });

  test("a frame with no byFamily is the base box at every canvas", () => {
    expect(resolveLayerFrame(BASE, { ratio: "1:1" })).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
    expect(resolveLayerFrame(BASE, { ratio: "9:16" })).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
    expect(resolveLayerFrame(BASE, { size: "300x250" })).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
    expect(resolveLayerFrame(BASE, { size: "728x90" })).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
  });

  test("a byFamily.size 300x250 override applies at 300x250 and not at 1:1 or 728x90", () => {
    const frame: LayerFrame = {
      ...BASE,
      byFamily: { size: { "300x250": { h: 0.25 } } },
    };
    expect(resolveLayerFrame(frame, { size: "300x250" })).toEqual({ x: 0, y: 0, w: 1, h: 0.25 });
    expect(resolveLayerFrame(frame, { ratio: "1:1" })).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
    expect(resolveLayerFrame(frame, { size: "728x90" })).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
  });

  test("a byFamily.ratio override applies at that ratio and not at a display size", () => {
    const frame: LayerFrame = {
      ...BASE,
      byFamily: { ratio: { "9:16": { y: 0.2, h: 0.3 } } },
    };
    expect(resolveLayerFrame(frame, { ratio: "9:16" })).toEqual({ x: 0, y: 0.2, w: 1, h: 0.3 });
    expect(resolveLayerFrame(frame, { ratio: "1:1" })).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
    expect(resolveLayerFrame(frame, { size: "300x250" })).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
  });

  test("empty byFamily maps and empty overlays leave the base box", () => {
    expect(resolveLayerFrame({ ...BASE, byFamily: {} }, { ratio: "1:1" })).toEqual({
      x: 0,
      y: 0,
      w: 1,
      h: 0.5,
    });
    expect(
      resolveLayerFrame({ ...BASE, byFamily: { size: { "300x250": {} } } }, { size: "300x250" }),
    ).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
  });
});
