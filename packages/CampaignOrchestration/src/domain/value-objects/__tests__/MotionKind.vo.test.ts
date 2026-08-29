import { describe, test, expect } from "vitest";
import { MOTION_KINDS, MOTION_FPS, restT } from "../MotionKind.vo.js";

describe("MotionKind", () => {
  test("declares the four motion kinds in lock order", () => {
    expect(MOTION_KINDS).toEqual(["ken-burns-in", "ken-burns-out", "headline-rise", "accent-wipe"]);
  });

  test("declares 30 fps as the domain motion frame rate", () => {
    expect(MOTION_FPS).toBe(30);
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
