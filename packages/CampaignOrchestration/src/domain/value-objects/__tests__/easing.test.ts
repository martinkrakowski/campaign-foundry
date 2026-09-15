import { describe, test, expect } from "vitest";
import { DEFAULT_EASING, EASING_KINDS, EASINGS, easeOutCubic } from "../easing.js";

// K-D7: `easeOutCubic` moves out of the compositor (`NodeCanvasCompositor.ts`)
// into the domain, byte-neutral — the expression is copied verbatim, so this
// pins the exact curve the compositor's goldens already depend on.
describe("easeOutCubic (K-D7)", () => {
  test("is the identity move of the compositor's own curve: 1 - (1 - t) ** 3", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875, 10);
    // Exact float bytes at a value with no rounding to hide behind — this
    // moved verbatim, not merely "close enough".
    expect(easeOutCubic(0.5)).toBe(1 - (1 - 0.5) ** 3);
    expect(easeOutCubic(0.25)).toBe(1 - (1 - 0.25) ** 3);
  });
});

describe("EASING_KINDS (K-D8)", () => {
  test("names exactly the default curve and its one override — do not invent more", () => {
    expect(EASING_KINDS).toEqual(["ease-out-cubic", "linear"]);
  });

  test("the default easing is ease-out-cubic", () => {
    expect(DEFAULT_EASING).toBe("ease-out-cubic");
    expect(EASING_KINDS).toContain(DEFAULT_EASING);
  });
});

describe("EASINGS (K1b's first reader)", () => {
  test("names a function for every EASING_KINDS member, and only those", () => {
    expect(Object.keys(EASINGS).sort()).toEqual([...EASING_KINDS].sort());
  });

  test("ease-out-cubic is the same function object as easeOutCubic", () => {
    expect(EASINGS["ease-out-cubic"]).toBe(easeOutCubic);
  });

  test("linear is the identity function", () => {
    expect(EASINGS.linear(0)).toBe(0);
    expect(EASINGS.linear(0.42)).toBe(0.42);
    expect(EASINGS.linear(1)).toBe(1);
  });
});
