import { readFile } from "node:fs/promises";
import type { InputAssetPort } from "@campaignfoundry/CampaignOrchestration";
import { resolveAssetPath } from "../safe-path.js";

/**
 * FileSystemInputAssets — InputAssetPort adapter over a project root.
 *
 * The one place the filesystem is reached for a brief's own assets. It delegates
 * confinement to {@link resolveAssetPath} rather than restating it, so this
 * adapter's `undefined` branch and that primitive's reject list cannot drift
 * apart — the same reason `FileSystemSceneAssetResolver` and
 * `FileSystemAudioAssetResolver` name it in their doc comments rather than
 * reimplementing it.
 *
 * It reads and does nothing else: no decoding, no cover-fit, no caching, no
 * existence memo. Those belong to the consumer that knows what the bytes are for,
 * and a consumer that needs a policy change must not have to change this adapter.
 * A rejection is re-thrown as-is rather than wrapped, so `code` (`ENOENT` above
 * all) reaches the consumer that branches on it — `NodeCanvasCompositor`'s logo
 * treats those two failures differently.
 *
 * `root` is the project root handed down from the composition root (D167, PT-0b1),
 * never read from the process environment here.
 */
export class FileSystemInputAssets implements InputAssetPort {
  /** @param root the project root whose `assets/` tree confines every read (D167). */
  constructor(private readonly root: string) {}

  async read(ref: string): Promise<Uint8Array | undefined> {
    const safePath = resolveAssetPath(ref, this.root);
    // An unsafe ref is not an error: every consumer treats it as "skip this
    // asset", so `undefined` — never a throw, which would abort a run over a
    // brief that merely named a path this root does not hold.
    if (safePath === undefined) return undefined;
    return await readFile(safePath);
  }
}
