import { describe, test, expect } from "vitest";
import { variantTreatmentId, type Variant } from "../Variant.js";

const variant = (over: Partial<Variant> = {}): Variant => ({
  index: 0,
  seed: 1,
  productId: "alpha",
  aspectRatio: "1:1",
  layout: "headline-top",
  tone: "bold",
  backgroundSource: "procedural",
  paletteShift: 0,
  ...over,
});

describe("variantTreatmentId", () => {
  test("synthesizes layout-tone as the treatment label", () => {
    expect(variantTreatmentId(variant())).toBe("headline-top-bold");
  });

  test("changes when layout or tone changes", () => {
    expect(variantTreatmentId(variant({ layout: "headline-bottom", tone: "subtle" }))).toBe(
      "headline-bottom-subtle",
    );
  });
});
