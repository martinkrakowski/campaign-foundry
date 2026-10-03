import { createCanvas, loadImage } from "@napi-rs/canvas";
import type {
  AspectRatio,
  InputAssetPort,
  SceneAssetPort,
} from "@campaignfoundry/CampaignOrchestration";

/**
 * FileSystemSceneAssetResolver — SceneAssetPort adapter.
 *
 * Cover-fits a beat's own background (VE5a `CopyBeat.background`) to a target
 * ratio exactly the way `AssetReusingImageGenerator.tryReuseAsset` fits a
 * product's `inputAsset` — the same confinement (the `InputAssetPort` its
 * constructor takes, which is `resolveAssetPath` confined to the project's
 * `assets/` tree), same center-crop cover-fit math. The two
 * deliberately diverge on failure: `tryReuseAsset` returns `undefined` so its
 * caller can fall through to generation — the right call for a product's base
 * ground, which always has a generated fallback. A scene has no such
 * fallback: VE-D3's "absent background" path covers a beat that names
 * NOTHING, not one that names a path nothing can read. So this adapter
 * REJECTS instead, and the use case (`resolveTimelineBackgrounds`) turns
 * that rejection into a run failure naming the offending beat and path.
 *
 * The port returns bytes and nothing else, so the decode stays here — the same
 * place it has always been, and the same reason the cover-fit math is not
 * extracted into a shared helper: it already lives inlined in three places in
 * this package (`AssetReusingImageGenerator`, `FireflyImageGenerator`,
 * `OpenRouterImageGenerator`), each behind its own golden-pinned adapter —
 * refactoring those is out of this lane's scope.
 */
export class FileSystemSceneAssetResolver implements SceneAssetPort {
  /** @param inputs the confined reader every scene is read through (PT-4c). */
  constructor(private readonly inputs: InputAssetPort) {}

  async resolveScene(path: string, ratio: AspectRatio): Promise<Uint8Array> {
    let bytes: Uint8Array | undefined;
    try {
      bytes = await this.inputs.read(path);
    } catch (cause) {
      throw new Error(`Scene "${path}" could not be read.`, { cause });
    }
    if (bytes === undefined) {
      throw new Error(`Scene "${path}" is not a valid asset path.`);
    }
    let image: Awaited<ReturnType<typeof loadImage>>;
    try {
      image = await loadImage(Buffer.from(bytes));
    } catch (cause) {
      throw new Error(`Scene "${path}" could not be read.`, { cause });
    }
    const canvas = createCanvas(ratio.width, ratio.height);
    const ctx = canvas.getContext("2d");
    const scale = Math.max(ratio.width / image.width, ratio.height / image.height);
    const w = image.width * scale;
    const h = image.height * scale;
    ctx.drawImage(image, (ratio.width - w) / 2, (ratio.height - h) / 2, w, h);
    return canvas.toBuffer("image/png");
  }
}
