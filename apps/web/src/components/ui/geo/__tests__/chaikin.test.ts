import { describe, test, expect } from "vitest";
import { chaikin, polyPath, type Pt } from "../chaikin";

// The ported mockup numbers are the fixtures. `chaikin`'s 0.75/0.25 corner-cutting
// weights are load-bearing: this suite pins exact points so changing a weight is a
// red test, not a silent redesign of every landmass.
describe("chaikin", () => {
  test("one pass cuts each corner at the mockup's 0.75/0.25 weights, endpoints preserved", () => {
    const line: Pt[] = [[0, 0], [10, 0]];
    expect(chaikin(line, 1)).toEqual([[0, 0], [2.5, 0], [7.5, 0], [10, 0]]);
  });

  test("two passes (the default) square the point count of each pass", () => {
    const square: Pt[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    // 4 anchors → 1 pass: 1 + 2·3 + 1 = 8 → 2 passes: 1 + 2·7 + 1 = 16.
    expect(chaikin(square).length).toBe(16);
    const smoothed = chaikin(square);
    expect(smoothed[0]).toEqual([0, 0]);
    expect(smoothed[smoothed.length - 1]).toEqual([0, 10]);
  });

  test("does not mutate its input", () => {
    const square: Pt[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const before = square.map(([x, y]) => [x, y] as Pt);
    chaikin(square);
    expect(square).toEqual(before);
  });
});

describe("polyPath", () => {
  const ONE_DECIMAL_PATH = /^M-?\d+\.\d -?\d+\.\d(L-?\d+\.\d -?\d+\.\d)*Z$/;

  test("starts with M, ends with Z, and every coordinate carries one decimal place", () => {
    const square: Pt[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const path = polyPath(square);
    expect(path.startsWith("M")).toBe(true);
    expect(path.endsWith("Z")).toBe(true);
    expect(path).toMatch(ONE_DECIMAL_PATH);
  });

  test("carries the smoothed point count, not the anchor count", () => {
    const square: Pt[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const corners = polyPath(square).match(/L/g);
    // 16 smoothed points: the M point plus 15 L points.
    expect(corners?.length).toBe(15);
  });
});
