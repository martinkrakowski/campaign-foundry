import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { projectRoot } from "@campaignfoundry/shared";
import { FileSystemAudioAssetResolver } from "../FileSystemAudioAssetResolver.js";

/**
 * Unlike FileSystemSceneAssetResolver (which decodes, cover-fits, and
 * re-encodes as PNG), this adapter must hand back the EXACT bytes on disk —
 * VE3b1's encoder muxes a music bed's bytes verbatim into ffmpeg's second
 * input, so any transformation here would desync the golden. `reuse-bg.png`
 * is an arbitrary binary fixture (not audio) used only to prove byte-for-byte
 * pass-through; the port itself never inspects content, only readability —
 * format validation is the upload boundary's job (asset-files.ts), not this
 * seam's.
 */
describe("FileSystemAudioAssetResolver (AudioAssetPort adapter)", () => {
  test("resolves a readable asset's bytes completely unchanged", async () => {
    const expected = readFileSync(resolve(projectRoot(), "assets", "inputs", "reuse-bg.png"));
    const out = await new FileSystemAudioAssetResolver(projectRoot()).resolveAudio(
      "assets/inputs/reuse-bg.png",
    );
    expect(Buffer.from(out)).toEqual(expected);
  });

  test("rejects an unsafe (absolute) path, never falling through silently", async () => {
    await expect(
      new FileSystemAudioAssetResolver(projectRoot()).resolveAudio("/etc/passwd"),
    ).rejects.toThrow(/not a valid asset path/);
  });

  test("rejects a path that escapes the confined assets tree", async () => {
    await expect(
      new FileSystemAudioAssetResolver(projectRoot()).resolveAudio("assets/../secrets.mp3"),
    ).rejects.toThrow(/not a valid asset path/);
  });

  test("rejects a missing audio file, naming it", async () => {
    await expect(
      new FileSystemAudioAssetResolver(projectRoot()).resolveAudio(
        "assets/inputs/does-not-exist.mp3",
      ),
    ).rejects.toThrow(/could not be read/);
  });
});
