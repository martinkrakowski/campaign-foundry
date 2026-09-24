import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { loadImage } from "@napi-rs/canvas";
import { projectRoot } from "@campaignfoundry/shared";
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
    const out = await new FileSystemSceneAssetResolver(projectRoot()).resolveScene(
      "assets/inputs/reuse-bg.png",
      target,
    );
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
    const out = await new FileSystemSceneAssetResolver(projectRoot()).resolveScene(
      "assets/inputs/reuse-bg.png",
      target,
    );
    const decoded = await loadImage(Buffer.from(out));
    expect(decoded.width).toBe(target.width);
    expect(decoded.height).toBe(target.height);
  });

  test("rejects an unsafe (absolute) path, never falling through silently", async () => {
    await expect(
      new FileSystemSceneAssetResolver(projectRoot()).resolveScene("/etc/passwd", ratio()),
    ).rejects.toThrow(/not a valid asset path/);
  });

  test("rejects a path that escapes the confined assets tree", async () => {
    await expect(
      new FileSystemSceneAssetResolver(projectRoot()).resolveScene(
        "assets/../secrets.png",
        ratio(),
      ),
    ).rejects.toThrow(/not a valid asset path/);
  });

  test("rejects a missing scene file", async () => {
    await expect(
      new FileSystemSceneAssetResolver(projectRoot()).resolveScene(
        "assets/inputs/does-not-exist.png",
        ratio(),
      ),
    ).rejects.toThrow(/could not be read/);
  });

  test("rejects an undecodable file (not an image)", async () => {
    await expect(
      new FileSystemSceneAssetResolver(projectRoot()).resolveScene(
        "assets/inputs/README.txt",
        ratio(),
      ),
    ).rejects.toThrow(/could not be read/);
  });
});

/**
 * VE3b2: a beat's `background` is an image-only field — proving that a
 * genuinely valid MP3/M4A upload (real magic bytes, not junk, which already
 * fails today) still cannot be used as a scene. It fails `loadImage` exactly
 * like any other undecodable file, so the existing reject path already
 * covers it; no new code needed, only proof.
 */
describe("FileSystemSceneAssetResolver — image-only enforcement against real audio magic (VE3b2)", () => {
  // Gitignored per-brief scratch dir (`/assets/inputs/*/`), so a crashed test
  // leaves nothing for git to see.
  const dir = resolve(projectRoot(), "assets", "inputs", "ve3b2-image-only-proof-scene");
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
    "a real, valid %s upload named as a beat's background is rejected, never silently accepted as a scene",
    async (name) => {
      await expect(
        new FileSystemSceneAssetResolver(projectRoot()).resolveScene(
          `assets/inputs/ve3b2-image-only-proof-scene/${name}`,
          ratio(),
        ),
      ).rejects.toThrow(/could not be read/);
    },
  );
});
