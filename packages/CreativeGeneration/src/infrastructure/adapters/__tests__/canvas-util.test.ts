import { describe, test, expect } from "vitest";
import { hexToRgb, wrapText } from "../canvas-util.js";

describe("hexToRgb", () => {
  test("parses a 6-digit hex with a leading #", () => {
    expect(hexToRgb("#1473E6")).toEqual([20, 115, 230]);
  });

  test("parses a 6-digit hex without a leading #", () => {
    expect(hexToRgb("1473E6")).toEqual([20, 115, 230]);
  });

  test("expands a 3-digit shorthand hex", () => {
    expect(hexToRgb("#14e")).toEqual([17, 68, 238]);
  });

  test("pads a too-short hex to six digits", () => {
    expect(hexToRgb("#abcd")).toEqual([171, 205, 0]);
  });
});

/** A canvas-context stand-in: width is the rendered string length × 10px. */
const measurer = { measureText: (text: string) => ({ width: text.length * 10 }) };

describe("wrapText", () => {
  test("keeps a short message on one line", () => {
    expect(wrapText(measurer, "Stay wild", 1000)).toEqual(["Stay wild"]);
  });

  test("wraps to a new line when the next word would overflow", () => {
    // "one two" = 70px fits in 100; adding "three" (130px) overflows → new line.
    expect(wrapText(measurer, "one two three", 100)).toEqual(["one two", "three"]);
  });

  test("emits an over-long single word on its own line", () => {
    expect(wrapText(measurer, "supercalifragilistic", 50)).toEqual(["supercalifragilistic"]);
  });

  test("falls back to the raw text when there are no words", () => {
    expect(wrapText(measurer, "   ", 100)).toEqual(["   "]);
  });
});
