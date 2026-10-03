/**
 * InputAssetPort — outbound port: read the BYTES of a brief-supplied input asset,
 * confined to the run's own assets tree.
 *
 * Five consumers read exactly this today — `AssetReusingImageGenerator` (a
 * product's `inputAsset`), `NodeCanvasCompositor` (a brief's logo),
 * `FileSystemSceneAssetResolver` (a beat's `background`), `FileSystemAudioAssetResolver`
 * (the music bed) and, through `prepare`, `CanvasFfmpegVideoCompositor` — and each
 * reached into a directory itself. That put one confinement rule behind five
 * copies of the same filesystem call, and it pinned "the brief's assets live in a
 * directory under the project root" into the domain: a storage backend could not be
 * substituted without rewriting all five.
 * This port is that seam, and nothing else changes about them (PT-4c): each keeps
 * its own decoding, its own cover-fit math and its own failure policy.
 *
 * The seam deliberately stops at BYTES. Decoding is not the storage backend's
 * business — an object store has no opinion about what a PNG is — so an adapter
 * returns what was stored and each consumer decodes it exactly as it did before.
 *
 * The confinement rule itself is an implementation's business, named nowhere
 * here: what this port fixes is the OUTCOME — `undefined` for exactly the unsafe
 * refs, bytes or a rejection for the rest — so that "this asset is unsafe" is one
 * decision made once, in one place, rather than five times in five directories.
 */
export interface InputAssetPort {
  /**
   * The bytes at `ref` — the same repo-relative asset reference
   * `Product.inputAsset`, `CompositeRequest.logoPath`, `CopyBeat.background` and
   * `CampaignBrief.audio.path` all hold.
   *
   * `undefined` — never a throw — when the ref is unsafe: empty or absent, an
   * absolute path, or anything whose resolved location is not strictly inside the
   * confined assets tree (`assets` itself, `assets/../x` and `../x` included).
   * Every consumer treats that as "skip this asset", so an unsafe ref must stay
   * indistinguishable from one that was never named.
   *
   * Otherwise the stored bytes, or the underlying failure REJECTED unchanged —
   * `code` intact, so a consumer can still tell a missing asset (`ENOENT`) from a
   * corrupt one. Each consumer's own policy then applies: the logo warns on a
   * corrupt file and skips a missing one silently, a scene and a music bed reject
   * either with the cause attached, and a reused product image falls through to
   * generation.
   */
  read(ref: string): Promise<Uint8Array | undefined>;
}
