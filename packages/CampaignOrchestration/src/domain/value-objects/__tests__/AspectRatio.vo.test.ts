import { describe, test, expect } from "vitest";
import type { LayerFrame } from "../creative-geometry.js";
import { RATIO_VALUES } from "../aspect-ratios.js";
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

describe("AspectRatio.forBackground — the generative region (D132)", () => {
  const frame = (x: number, y: number, w: number, h: number): LayerFrame => ({
    x,
    y,
    w,
    h,
    anchor: "top",
  });

  test("a ground filling the top half of a square asks for a wide picture, not a square one", () => {
    // The whole of D132: the canvas is 1:1 and the box the picture must fill is
    // 2:1, so a square generation would be cropped to a third of its subject.
    expect(AspectRatio.forBackground({ ratio: "1:1" }, frame(0, 0, 1, 0.5)).value).toBe("16:9");
  });

  test("a ground filling a tall half asks for a tall picture", () => {
    expect(AspectRatio.forBackground({ ratio: "1:1" }, frame(0, 0, 0.5, 1)).value).toBe("9:16");
  });

  test("a full-canvas frame answers exactly what no frame answers", () => {
    // Spelling out the default must not change the request — the D134 idiom.
    for (const spec of [{ ratio: "1:1" } as const, { size: "300x250" } as const]) {
      expect(AspectRatio.forBackground(spec, frame(0, 0, 1, 1)).value).toBe(
        AspectRatio.forBackground(spec).value,
      );
    }
  });

  test("an absent frame is the pre-D132 answer on every ratio and a display size", () => {
    for (const ratio of RATIO_VALUES) {
      expect(AspectRatio.forBackground({ ratio }).value).toBe(ratio);
    }
    // A leaderboard still borrows the nearest orientation (D113), unchanged.
    expect(AspectRatio.forBackground({ size: "728x90" }).value).toBe("16:9");
  });

  test("the frame is resolved for the spec, so byFamily changes only its own size", () => {
    const framed: LayerFrame = {
      ...frame(0, 0, 1, 1),
      byFamily: { size: { "300x250": { w: 0.4, h: 1 } } },
    };
    // 300x250 takes the override and asks tall; 728x90 does not consult `size`
    // entries it does not name, so it answers as the unframed leaderboard does.
    expect(AspectRatio.forBackground({ size: "300x250" }, framed).value).toBe("9:16");
    expect(AspectRatio.forBackground({ size: "728x90" }, framed).value).toBe(
      AspectRatio.forBackground({ size: "728x90" }).value,
    );
  });
});
