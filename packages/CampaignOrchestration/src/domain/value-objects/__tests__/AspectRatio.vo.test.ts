import { describe, test, expect } from "vitest";
import { AspectRatio } from "../AspectRatio.vo.js";

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

  test("equals compares by value", () => {
    const oneByOne = AspectRatio.all()[0];
    const same = AspectRatio.create("1:1");
    const other = AspectRatio.create("16:9");
    expect(same.success && other.success).toBe(true);
    if (same.success) expect(oneByOne.equals(same.value)).toBe(true);
    if (other.success) expect(oneByOne.equals(other.value)).toBe(false);
  });
});
