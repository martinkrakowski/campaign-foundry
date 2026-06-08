import { describe, test, expect, vi } from "vitest";
import { AspectRatio, type ImageGeneratorPort } from "@campaignfoundry/CampaignOrchestration";
import { AssetReusingImageGenerator } from "../AssetReusingImageGenerator.js";

const ratio = (v = "1:1") => {
  const r = AspectRatio.create(v);
  if (!r.success) throw r.error;
  return r.value;
};
const ctx = { campaignMessage: "m", targetAudience: "a", targetRegion: "r" };
const baseProduct = { id: "p", name: "P", primaryColor: "#1473E6", logoPath: "x.png" };

const delegate = (): ImageGeneratorPort => ({
  resolveBackground: vi.fn(async () => ({ image: new Uint8Array([9]), source: "procedural" as const })),
});

describe("AssetReusingImageGenerator (decorator)", () => {
  test("reuses a readable input asset without delegating", async () => {
    const inner = delegate();
    const out = await new AssetReusingImageGenerator(inner).resolveBackground(
      { ...baseProduct, inputAsset: "assets/inputs/hydra-logo.png" },
      ratio("1:1"),
      ctx,
    );
    expect(out.source).toBe("reused");
    expect(out.image.length).toBeGreaterThan(0);
    expect(inner.resolveBackground).not.toHaveBeenCalled();
  });

  test("delegates when no input asset is supplied", async () => {
    const inner = delegate();
    const out = await new AssetReusingImageGenerator(inner).resolveBackground(baseProduct, ratio(), ctx);
    expect(out.source).toBe("procedural");
    expect(inner.resolveBackground).toHaveBeenCalledTimes(1);
  });

  test("delegates when the input asset path is unsafe (absolute)", async () => {
    const inner = delegate();
    const out = await new AssetReusingImageGenerator(inner).resolveBackground(
      { ...baseProduct, inputAsset: "/etc/passwd" },
      ratio(),
      ctx,
    );
    expect(out.source).toBe("procedural");
    expect(inner.resolveBackground).toHaveBeenCalledTimes(1);
  });

  test("delegates when the input asset is missing or unreadable", async () => {
    const inner = delegate();
    const out = await new AssetReusingImageGenerator(inner).resolveBackground(
      { ...baseProduct, inputAsset: "assets/inputs/does-not-exist.png" },
      ratio(),
      ctx,
    );
    expect(out.source).toBe("procedural");
    expect(inner.resolveBackground).toHaveBeenCalledTimes(1);
  });
});
