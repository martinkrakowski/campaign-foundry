import type { AudioAssetPort, InputAssetPort } from "@campaignfoundry/CampaignOrchestration";

/**
 * FileSystemAudioAssetResolver — AudioAssetPort adapter.
 *
 * Reuses the SAME confinement primitive `FileSystemSceneAssetResolver` uses
 * (the `InputAssetPort` its constructor takes, which is `resolveAssetPath`
 * confined to the project's `assets/` tree) and the same
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
  /** @param inputs the confined reader every bed is read through (PT-4c). */
  constructor(private readonly inputs: InputAssetPort) {}

  async resolveAudio(path: string): Promise<Uint8Array> {
    let bytes: Uint8Array | undefined;
    try {
      bytes = await this.inputs.read(path);
    } catch (cause) {
      throw new Error(`Audio "${path}" could not be read.`, { cause });
    }
    if (bytes === undefined) {
      throw new Error(`Audio "${path}" is not a valid asset path.`);
    }
    return bytes;
  }
}
