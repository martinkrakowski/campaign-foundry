import { describe, test, expect } from "vitest";
import {
  isPaletteShift,
  normalizeHueTurns,
  MIN_PALETTE_SHIFT,
  MAX_PALETTE_SHIFT_EXCLUSIVE,
} from "../palette-shift.js";

describe("isPaletteShift — what the parser will honour exactly as written", () => {
  test("accepts the half-open range [0, 1)", () => {
    for (const v of [0, 0.1, 0.2, 0.5, 0.999999]) expect(isPaletteShift(v)).toBe(true);
  });

  test("refuses a whole turn, because it means the same as no turn", () => {
    expect(isPaletteShift(MAX_PALETTE_SHIFT_EXCLUSIVE)).toBe(false);
    expect(normalizeHueTurns(1)).toBe(MIN_PALETTE_SHIFT);
  });

  test("refuses negatives, more than a turn, and non-numbers", () => {
    for (const v of [-0.1, -1, 1.1, 7, Number.NaN, Number.POSITIVE_INFINITY, "0.1", null, undefined]) {
      expect(isPaletteShift(v)).toBe(false);
    }
  });
});

describe("normalizeHueTurns — one wrap, shared by the preview and the render", () => {
  test("is the identity on the accepted range", () => {
    for (const v of [0, 0.1, 0.25, 0.9]) expect(normalizeHueTurns(v)).toBeCloseTo(v, 12);
  });

  test("wraps a negative turn forward, never leaving it negative", () => {
    // The defect this module exists for: the editor used to compute (h + shift) % 1, which
    // for hue 0.05 and shift -0.1 is -0.05 — a hue the renderer never produces.
    expect(normalizeHueTurns(0.05 - 0.1)).toBeCloseTo(0.95, 12);
    expect(normalizeHueTurns(-1.25)).toBeCloseTo(0.75, 12);
    for (const v of [-0.001, -0.5, -3.7]) expect(normalizeHueTurns(v)).toBeGreaterThanOrEqual(0);
  });

  test("wraps more than a turn back into range", () => {
    expect(normalizeHueTurns(1.1)).toBeCloseTo(0.1, 12);
    expect(normalizeHueTurns(2)).toBe(0);
  });

  test("a non-finite turn is no turn, not NaN", () => {
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(normalizeHueTurns(v)).toBe(0);
    }
  });
});
