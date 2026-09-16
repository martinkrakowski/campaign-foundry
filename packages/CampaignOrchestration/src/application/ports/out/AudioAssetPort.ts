/**
 * AudioAssetPort — outbound port: resolve a brief's music bed (`CampaignBrief.audio.path`,
 * VE-D8) to its raw bytes, unchanged.
 *
 * This is a NARROWER port than {@link SceneAssetPort}, deliberately not reused verbatim
 * for `audio.path` even though both resolve a brief-supplied asset path: `SceneAssetPort`
 * decodes its file as an image, cover-fits it to a target `AspectRatio`, and re-encodes it
 * as PNG — the bytes it returns are never the bytes it was given. A music bed needs the
 * OPPOSITE guarantee: `CanvasFfmpegVideoCompositor` (VE3b1) muxes the exact uploaded bytes,
 * untouched, as ffmpeg's second input — there is no ratio to cover-fit against, and no
 * image decode an mp3/m4a container would do anything but fail. Reusing `resolveScene`'s
 * signature would mean decoding a music bed as an image and rejecting every upload; this
 * port keeps only what actually transfers from that seam — the same confinement primitive
 * (`resolveAssetPath`) and the same reject-never-fall-back-silently contract, since a music
 * bed the user uploaded and paid to licence has no generated fallback either.
 */
export interface AudioAssetPort {
  /**
   * `path` is the same repo-relative asset reference `CampaignBrief.audio.path` holds.
   * Rejects when the path is unsafe (escapes the confined assets tree) or the file
   * cannot be read.
   */
  resolveAudio(path: string): Promise<Uint8Array>;
}
