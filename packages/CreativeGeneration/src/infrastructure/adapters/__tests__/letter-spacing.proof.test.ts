import { describe, test, expect } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { createHash } from "node:crypto";
import { registerBundledFonts } from "../../fonts.js";

/**
 * The F1 premise (plan 2026-09-01, §8 "treat T4–T6's first lane as re-verifying
 * them in-repo before building on it"): on `@napi-rs/canvas` (Skia), the
 * `letterSpacing` context property works in BOTH `measureText` and the raster.
 * Every letter-spacing control downstream (the T5 `style.letterSpacing` field,
 * its layout math and its blit) is built on this — if it fails, the control has
 * no engine to stand on and must not ship.
 */
describe("F1 — ctx.letterSpacing drives measureText and the raster (re-verified in-repo)", () => {
  registerBundledFonts();
  const MESSAGE = "Stay wild, stay hydrated";

  test("letterSpacing 10px shifts measureText by exactly glyphs × 10", () => {
    const ctx = createCanvas(10, 10).getContext("2d");
    ctx.font = "700 65px Inter, sans-serif";
    const base = ctx.measureText(MESSAGE).width;
    ctx.letterSpacing = "10px";
    const spaced = ctx.measureText(MESSAGE).width;
    // CSS letter-spacing adds the advance after EVERY glyph (including the last).
    expect(spaced - base).toBeCloseTo(MESSAGE.length * 10, 6);
  });

  test("letterSpacing changes the raster hash at the registered Inter face", () => {
    const raster = (letterSpacing: string): string => {
      const canvas = createCanvas(1080, 400);
      const ctx = canvas.getContext("2d");
      ctx.font = "700 65px Inter, sans-serif";
      ctx.letterSpacing = letterSpacing;
      ctx.fillStyle = "#000000";
      ctx.fillText(MESSAGE, 40, 200);
      return createHash("sha256").update(canvas.toBuffer("image/png")).digest("hex");
    };
    expect(raster("0px")).not.toBe(raster("10px"));
  });
});
