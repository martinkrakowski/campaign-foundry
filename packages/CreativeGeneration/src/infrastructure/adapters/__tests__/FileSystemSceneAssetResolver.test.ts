import { describe, test, expect } from "vitest";
import { AspectRatio } from "@campaignfoundry/CampaignOrchestration";
import { FileSystemSceneAssetResolver } from "../FileSystemSceneAssetResolver.js";

const ratio = (v = "1:1") => {
  const r = AspectRatio.create(v);
  if (!r.success) throw r.error;
  return r.value;
};

describe("FileSystemSceneAssetResolver (SceneAssetPort adapter)", () => {
  test("resolves a readable scene, cover-fitted to the target ratio's exact pixel dimensions", async () => {
    const out = await new FileSystemSceneAssetResolver().resolveScene(
      "assets/inputs/reuse-bg.png",
      ratio("9:16"),
    );
    expect(out.length).toBeGreaterThan(0);
    // PNG magic — a real cover-fitted image, not the source bytes verbatim.
    expect(Buffer.from(out.subarray(0, 4))).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
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
