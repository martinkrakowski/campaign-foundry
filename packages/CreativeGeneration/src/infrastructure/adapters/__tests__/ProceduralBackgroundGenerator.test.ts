import { describe, test, expect } from "vitest";
import { AspectRatio } from "@campaignfoundry/CampaignOrchestration";
import { ProceduralBackgroundGenerator } from "../ProceduralBackgroundGenerator.js";

const ratio = (v = "1:1") => {
  const r = AspectRatio.create(v);
  if (!r.success) throw r.error;
  return r.value;
};
const product = { id: "p", name: "P", primaryColor: "#1473E6", logoPath: "x.png" };
const ctx = { campaignMessage: "m", targetAudience: "a", targetRegion: "r" };

describe("ProceduralBackgroundGenerator", () => {
  const gen = new ProceduralBackgroundGenerator();

  test("returns a procedural-sourced PNG", async () => {
    const out = await gen.resolveBackground(product, ratio("1:1"), ctx);
    expect(out.source).toBe("procedural");
    expect(out.image.length).toBeGreaterThan(0);
    expect(Array.from(out.image.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]); // PNG magic
  });

  test("is deterministic for the same brand colour and ratio", async () => {
    const a = await gen.resolveBackground(product, ratio("9:16"), ctx);
    const b = await gen.resolveBackground(product, ratio("9:16"), ctx);
    expect(Buffer.from(a.image).equals(Buffer.from(b.image))).toBe(true);
  });

  test("paletteShift 0 or absent is byte-identical to today", async () => {
    const none = await gen.resolveBackground(product, ratio(), ctx);
    const zero = await gen.resolveBackground(product, ratio(), { ...ctx, paletteShift: 0 });
    expect(Buffer.from(none.image).equals(Buffer.from(zero.image))).toBe(true);
  });

  test("a non-zero paletteShift changes bytes deterministically", async () => {
    const none = await gen.resolveBackground(product, ratio(), ctx);
    const shifted = await gen.resolveBackground(product, ratio(), { ...ctx, paletteShift: 0.1 });
    const again = await gen.resolveBackground(product, ratio(), { ...ctx, paletteShift: 0.1 });
    expect(Buffer.from(none.image).equals(Buffer.from(shifted.image))).toBe(false);
    expect(Buffer.from(shifted.image).equals(Buffer.from(again.image))).toBe(true);
  });

  test("hue-shifts saturated red, green, blue, and a light tint", async () => {
    const colors = ["#E0218A", "#FF8800", "#22CC44", "#1473E6", "#FFCCCC", "#220044", "#808080"];
    for (const primaryColor of colors) {
      const p = { ...product, primaryColor };
      const a = await gen.resolveBackground(p, ratio(), { ...ctx, paletteShift: 0.25 });
      const b = await gen.resolveBackground(p, ratio(), { ...ctx, paletteShift: 0.75 });
      expect(a.image.length).toBeGreaterThan(0);
      expect(b.image.length).toBeGreaterThan(0);
    }
  });

  test("wraps a paletteShift outside 0..1 and ignores non-finite values", async () => {
    const base = await gen.resolveBackground(product, ratio(), { ...ctx, paletteShift: 0.1 });
    const wrapped = await gen.resolveBackground(product, ratio(), { ...ctx, paletteShift: 1.1 });
    const negative = await gen.resolveBackground(product, ratio(), { ...ctx, paletteShift: -0.9 });
    const nan = await gen.resolveBackground(product, ratio(), { ...ctx, paletteShift: Number.NaN });
    const none = await gen.resolveBackground(product, ratio(), ctx);
    expect(Buffer.from(base.image).equals(Buffer.from(wrapped.image))).toBe(true);
    expect(Buffer.from(base.image).equals(Buffer.from(negative.image))).toBe(true);
    expect(Buffer.from(nan.image).equals(Buffer.from(none.image))).toBe(true);
  });
});
