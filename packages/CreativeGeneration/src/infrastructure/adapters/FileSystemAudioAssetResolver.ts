import { readFile } from "node:fs/promises";
import type { AudioAssetPort } from "@campaignfoundry/CampaignOrchestration";
import { resolveAssetPath } from "../safe-path.js";

/**
 * FileSystemAudioAssetResolver — AudioAssetPort adapter.
 *
 * Reuses the SAME confinement primitive `FileSystemSceneAssetResolver` uses
 * (`resolveAssetPath`, confined to the project's `assets/` tree) and the same
 * reject-never-fall-back-silently contract — a music bed the user uploaded and
 * licenced has no generated fallback. It does NOT reuse `SceneAssetPort`'s
 * `resolveScene` method: that decodes the file as an image, cover-fits it to a
 * target `AspectRatio`, and re-encodes it as PNG, so its output bytes are never
 * its input bytes. `CanvasFfmpegVideoCompositor` needs the opposite guarantee
 * for a music bed (VE3b1): the exact uploaded bytes, untouched, muxed straight
 * into ffmpeg's second input — no ratio to cover-fit against, and no image
 * decode an mp3/m4a container would survive anyway. This adapter is the
 * narrower port that actually fits: read the bytes, change nothing.
 */
export class FileSystemAudioAssetResolver implements AudioAssetPort {
  /** @param assetRoot the project root whose `assets/` tree confines every read (D167). */
  constructor(private readonly assetRoot: string) {}

  async resolveAudio(path: string): Promise<Uint8Array> {
    const safePath = resolveAssetPath(path, this.assetRoot);
    if (!safePath) {
      throw new Error(`Audio "${path}" is not a valid asset path.`);
    }
    try {
      return await readFile(safePath);
    } catch (cause) {
      throw new Error(`Audio "${path}" could not be read.`, { cause });
    }
  }
}
