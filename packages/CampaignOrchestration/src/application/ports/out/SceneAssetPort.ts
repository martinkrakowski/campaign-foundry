import type { AspectRatio } from "../../../domain/value-objects/AspectRatio.vo.js";

/**
 * SceneAssetPort — outbound port: resolve a timeline beat's own background
 * (`CopyBeat.background`, VE5a) to PNG bytes cover-fitted to a canvas ratio —
 * the same kind of reference a product's `inputAsset` holds, but for a beat's
 * scene rather than a product's base ground.
 *
 * Unlike `ImageGeneratorPort.resolveBackground` (which always degrades to a
 * procedural fallback and never fails), this port never falls back silently:
 * a beat names an asset the user uploaded and paid to keep, so an unreadable
 * or unsafe path REJECTS. `GenerateCampaignUseCase` and
 * `PreviewCreativeFrameUseCase` turn that rejection into a run failure naming
 * the beat and the path (VE5b2) — never a quiet draw of the creative's own
 * ground, which is VE-D3's fallback for an ABSENT background, not an
 * unreadable one.
 */
export interface SceneAssetPort {
  /**
   * `path` is the same repo-relative asset reference `Product.inputAsset`
   * holds. Rejects when the path is unsafe (escapes the confined assets
   * tree) or the file cannot be read or decoded as an image.
   */
  resolveScene(path: string, ratio: AspectRatio): Promise<Uint8Array>;
}
