import { describe, test, expect } from "vitest";
import { AspectRatio } from "../AspectRatio.vo.js";
import { resolveCanvas } from "../aspect-ratios.js";

describe("AspectRatio", () => {
  test("create returns the canvas dimensions for each supported ratio", () => {
    const expected = [
      ["1:1", 1080, 1080],
      ["9:16", 1080, 1920],
      ["16:9", 1920, 1080],
    ] as const;
    for (const [value, width, height] of expected) {
      const r = AspectRatio.create(value);
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.value.value).toBe(value);
        expect(r.value.width).toBe(width);
        expect(r.value.height).toBe(height);
      }
    }
  });

  test("create rejects an unsupported ratio", () => {
    const r = AspectRatio.create("4:3");
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.message).toMatch(/Unsupported aspect ratio "4:3"/);
  });

  test("all returns every supported ratio in display order", () => {
    expect(AspectRatio.all().map((a) => a.value)).toEqual(["1:1", "9:16", "16:9"]);
  });

  test("slug replaces the colon with x for filesystem paths", () => {
    const r = AspectRatio.create("9:16");
    expect(r.success).toBe(true);
    if (r.success) expect(r.value.slug).toBe("9x16");
  });

  test("forBackground maps a spec onto the ratio the background port speaks (D113)", () => {
    // A ratio spec is itself; a display unit asks for the nearest social
    // ratio's orientation, so a leaderboard requests a wide background.
    const square = AspectRatio.forBackground({ ratio: "1:1" });
    expect(square.value).toBe("1:1");
    expect(square.width).toBe(1080);
    expect(square.height).toBe(1080);
    const leaderboard = AspectRatio.forBackground({ size: "728x90" });
    expect(leaderboard.value).toBe("16:9");
    expect(leaderboard.width).toBe(1920);
    expect(leaderboard.height).toBe(1080);
  });

  test("create width equals resolveCanvas for the same ratio — the VO reads through the resolver", () => {
    const r = AspectRatio.create("1:1");
    expect(r.success).toBe(true);
    if (r.success) expect(r.value.width).toBe(resolveCanvas({ ratio: "1:1" }).width);
  });

  test("equals compares by value", () => {
    const oneByOne = AspectRatio.all()[0];
    const same = AspectRatio.create("1:1");
    const other = AspectRatio.create("16:9");
    expect(same.success && other.success).toBe(true);
    if (same.success) expect(oneByOne.equals(same.value)).toBe(true);
    if (other.success) expect(oneByOne.equals(other.value)).toBe(false);
  });
});
