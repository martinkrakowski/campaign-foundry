import { describe, test, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { projectRoot } from "@campaignfoundry/shared";
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

/**
 * VE3b2: `inputAsset` is an image-only field — proving that a genuinely valid
 * MP3/M4A upload (real magic bytes, not junk, which already fails today)
 * still cannot be reused as a background. It fails `loadImage` exactly like
 * any other undecodable file, so the existing catch-and-delegate path already
 * covers it; no new code needed, only proof.
 */
describe("AssetReusingImageGenerator — image-only enforcement against real audio magic (VE3b2)", () => {
  // Gitignored per-brief scratch dir (`/assets/inputs/*/`), so a crashed test
  // leaves nothing for git to see.
  const dir = resolve(projectRoot(), "assets", "inputs", "ve3b2-image-only-proof");
  const mp3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x22]);
  const m4a = Buffer.from([
    0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 0x00, 0x00, 0x02, 0x00,
  ]);

  beforeAll(() => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "bed.mp3"), mp3);
    writeFileSync(resolve(dir, "bed.m4a"), m4a);
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test.each(["bed.mp3", "bed.m4a"])(
    "a real, valid %s upload named as inputAsset falls through to generation, never 'reused'",
    async (name) => {
      const inner = delegate();
      const out = await new AssetReusingImageGenerator(inner).resolveBackground(
        { ...baseProduct, inputAsset: `assets/inputs/ve3b2-image-only-proof/${name}` },
        ratio(),
        ctx,
      );
      expect(out.source).toBe("procedural");
      expect(inner.resolveBackground).toHaveBeenCalledTimes(1);
    },
  );
});
