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
});
