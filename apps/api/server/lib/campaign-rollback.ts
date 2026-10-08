import { errorMessage } from "@campaignfoundry/shared";
import { objectStore } from "./config.js";
import { deletePool, withPoolLock } from "./pools.js";
import type { BriefStorePort } from "./ports/brief-store.port.js";
import { getAssetStore } from "./ports/index.js";
import type { StorageScope } from "./run-environment.js";

/**
 * Undo a reserved campaign after a write failed once `createCampaign` had held the slug
 * (create and duplicate share it). The caller rethrows its own error afterwards; this
 * never returns it, and a failure of the pool delete or the release propagates and
 * replaces it, exactly as the two inline copies did. In this order:
 * 1. the pool, first: it lives in the reserved directory `releaseCampaign` removes on fs,
 *    and a non-empty directory would make that answer false for no reason;
 * 2. the assets this request created, by SLUG, BEFORE the release (PT-4b: s3 can only
 *    resolve the slug into its prefix while the campaign row exists). Only `createdIds`
 *    are freed (PT-9j, D237 a). Off `s3` the `hasVersion` question is asked first: a
 *    second writer that already versioned this slug owns its files, and NOT freeing is
 *    the safe direction; `campaignMeta` that throws or answers `undefined` frees nothing.
 *    Neither it nor the free may replace the original error: they are warned and swallowed;
 * 3. `releaseCampaign`, which carries the same versioned-slug guard independently.
 */
export async function rollbackReservedCampaign(
  scope: StorageScope,
  store: Pick<BriefStorePort, "campaignMeta" | "releaseCampaign">,
  targetSlug: string,
  createdIds: readonly string[],
  operation: "create" | "duplicate",
): Promise<void> {
  await withPoolLock(scope, targetSlug, () => deletePool(scope, targetSlug));
  if (createdIds.length > 0) {
    try {
      if (objectStore() === "s3" || (await store.campaignMeta(targetSlug))?.hasVersion === false) {
        await getAssetStore(scope).freeUnreferencedAssets(targetSlug, createdIds);
      }
    } catch (cleanup) {
      console.warn(
        `[campaigns] could not free the assets of "${targetSlug}" after a failed ${operation}: ${errorMessage(cleanup)}`,
      );
    }
  }
  await store.releaseCampaign(targetSlug);
}
