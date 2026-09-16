import { describe, test, expect } from "vitest";
import { loadImage } from "@napi-rs/canvas";
import { AspectRatio } from "@campaignfoundry/CampaignOrchestration";
import { FileSystemSceneAssetResolver } from "../FileSystemSceneAssetResolver.js";

const ratio = (v = "1:1") => {
  const r = AspectRatio.create(v);
  if (!r.success) throw r.error;
  return r.value;
};

/**
 * `assets/inputs/reuse-bg.png` is a real, square (1920×1920) demo asset — a
 * fixed known size distinct from every social ratio's own dimensions, so a
 * decoded result whose width/height match the SOURCE instead of the
 * requested ratio (an adapter that ignores `ratio` entirely, e.g. resolving
 * at the source image's own size) fails these assertions rather than merely
 * producing "a non-empty PNG".
 */
describe("FileSystemSceneAssetResolver (SceneAssetPort adapter)", () => {
  test("resolves a readable scene, cover-fitted to the target ratio's exact pixel dimensions", async () => {
    const target = ratio("9:16");
    const out = await new FileSystemSceneAssetResolver().resolveScene("assets/inputs/reuse-bg.png", target);
    expect(out.length).toBeGreaterThan(0);
    // PNG magic — a real cover-fitted image, not the source bytes verbatim.
    expect(Buffer.from(out.subarray(0, 4))).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    // Decode and assert BOTH dimensions match the requested canvas exactly —
    // a resolver that ignores `ratio` (e.g. keeps the source's own 1920×1920)
    // would fail here even though it still returns a valid, non-empty PNG.
    const decoded = await loadImage(Buffer.from(out));
    expect(decoded.width).toBe(target.width);
    expect(decoded.height).toBe(target.height);
  });

  test("cover-fits to a second, differently-shaped ratio too — the dimensions track the request, not a fixed output size", async () => {
    const target = ratio("16:9");
    const out = await new FileSystemSceneAssetResolver().resolveScene("assets/inputs/reuse-bg.png", target);
    const decoded = await loadImage(Buffer.from(out));
    expect(decoded.width).toBe(target.width);
    expect(decoded.height).toBe(target.height);
  });

  test("rejects an unsafe (absolute) path, never falling through silently", async () => {
    await expect(
      new FileSystemSceneAssetResolver().resolveScene("/etc/passwd", ratio()),
    ).rejects.toThrow(/not a valid asset path/);
  });

  test("rejects a path that escapes the confined assets tree", async () => {
    await expect(
      new FileSystemSceneAssetResolver().resolveScene("assets/../secrets.png", ratio()),
    ).rejects.toThrow(/not a valid asset path/);
  });

  test("rejects a missing scene file", async () => {
    await expect(
      new FileSystemSceneAssetResolver().resolveScene("assets/inputs/does-not-exist.png", ratio()),
    ).rejects.toThrow(/could not be read/);
  });

  test("rejects an undecodable file (not an image)", async () => {
    await expect(
      new FileSystemSceneAssetResolver().resolveScene("assets/inputs/README.txt", ratio()),
    ).rejects.toThrow(/could not be read/);
  });
});
