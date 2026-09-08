import { describe, test, expect } from "vitest";
import { DISPLAY_SIZES, DISPLAY_SIZE_VALUES, type DisplaySize } from "../display-sizes.js";
import { resolveCanvas } from "../aspect-ratios.js";

describe("display sizes (D113)", () => {
  test("the vocabulary is exactly the five IAB units, in table order", () => {
    expect(DISPLAY_SIZE_VALUES).toEqual(["300x250", "728x90", "160x600", "320x50", "300x600"]);
  });

  test("the five sizes resolve to exactly the plan's §0 table", () => {
    const table = [
      ["300x250", 300, 250],
      ["728x90", 728, 90],
      ["160x600", 160, 600],
      ["320x50", 320, 50],
      ["300x600", 300, 600],
    ] as const;
    for (const [size, width, height] of table) {
      expect(DISPLAY_SIZES[size]).toEqual({ width, height });
      expect(resolveCanvas({ size })).toEqual({ width, height });
    }
  });

  test("the union is compile-locked: a sixth size is a type error until added", () => {
    const names: readonly DisplaySize[] = DISPLAY_SIZE_VALUES;
    expect(names).toHaveLength(5);
  });
});
