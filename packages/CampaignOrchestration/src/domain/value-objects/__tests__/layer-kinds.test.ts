import { describe, test, expect } from "vitest";
import { LAYER_KINDS, type LayerKind } from "../layer-kinds.js";

describe("layer kinds (D119, D131)", () => {
  test("the vocabulary contains exactly the nine atoms, including fill", () => {
    expect(LAYER_KINDS).toEqual([
      "image",
      "fill",
      "static-text",
      "animated-text",
      "html",
      "video",
      "logo",
      "accent",
      "shade",
    ]);
  });

  test("the union is compile-locked", () => {
    const kinds: readonly LayerKind[] = LAYER_KINDS;
    expect(kinds).toHaveLength(9);
    const _kind: LayerKind = "fill";
    expect(_kind).toBe("fill");
  });
});
