import { describe, test, expect } from "vitest";
import { MOTION_KINDS, restT } from "../MotionKind.vo.js";

describe("MotionKind", () => {
  test("declares the four motion kinds in lock order", () => {
    expect(MOTION_KINDS).toEqual(["ken-burns-in", "ken-burns-out", "headline-rise", "accent-wipe"]);
  });

  test.each([
    ["ken-burns-in", 1],
    ["ken-burns-out", 0],
    ["headline-rise", 1],
    ["accent-wipe", 1],
  ] as const)("%s restT is %i", (kind, t) => {
    expect(restT(kind)).toBe(t);
  });
});
