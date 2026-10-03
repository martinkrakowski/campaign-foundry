import {
  assertObjectKey,
  type BackgroundCachePort,
  type ObjectContent,
  type ObjectKey,
  type ObjectStorePort,
} from "@campaignfoundry/CampaignOrchestration";
import { isPngBuffer } from "./FileSystemBackgroundCache.js";

/**
 * ObjectBackgroundCache — `BackgroundCachePort` over `ObjectStorePort`
 * (PT-4e), at `<prefix><sha256>.png`, where `prefix` is
 * `org/<orgId>/cache/` (D203).
 *
 * **Everything that decides what a cache entry IS is inherited unchanged** from
 * `FileSystemBackgroundCache`, and the tests here are the same tests: the key
 * rule (sha256 hex, refused on `set` and a miss on `get`, so a bad key can
 * never name anything), the PNG-signature check, the best-effort delete of a
 * corrupt entry, and the per-instance in-flight dedupe. A change to any of those
 * on one backend and not the other would be two caches with two definitions of
 * a hit, which is why the shared helper and not a second copy.
 *
 * The one thing it does NOT have is the fs adapter's tmp-plus-rename. A PUT is
 * atomic: a reader sees the whole object or no object, so there is no window in
 * which a half-written PNG is readable and has to be defended against.
 */
export class ObjectBackgroundCache implements BackgroundCachePort {
  private readonly inflight = new Map<string, Promise<void>>();

  /**
   * @param store the process's object store, shared with every other writer.
   * @param prefix the org's cache prefix, trailing `/` included — see `cachePrefix`.
   */
  constructor(
    private readonly store: ObjectStorePort,
    private readonly prefix: string,
  ) {}

  async get(key: string): Promise<Uint8Array | undefined> {
    let objectKey: ObjectKey;
    try {
      objectKey = this.keyFor(key);
    } catch {
      // A key this cache would refuse is a miss, exactly as on fs: the caller
      // regenerates, and a refusal is not something it can act on.
      return undefined;
    }
    let content: ObjectContent | undefined;
    try {
      content = await this.store.get(objectKey);
    } catch {
      // A store that cannot answer is a MISS, not a failed run: the fs adapter
      // swallows ENOENT the same way, and this is the same miss for the same
      // reason — an entry that cannot be read is not a hit.
      return undefined;
    }
    if (content === undefined) return undefined;
    if (!isPngBuffer(content.bytes)) {
      await this.deleteCorrupt(objectKey);
      return undefined;
    }
    return content.bytes;
  }

  /**
   * Two concurrent sets of one key cost ONE put, as on fs: a run renders eight
   * cells at a time and the reuse wrapper resolves the same background for each
   * of them, so without this one prompt's image is uploaded N times.
   *
   * The entry is registered before the first `await` inside it and released in
   * `finally`, which is what makes the dedupe hold for the WINDOW and not just
   * for the instant after the map write — and releasing in `finally` is what
   * makes a FAILED write retryable rather than remembered as done.
   */
  set(key: string, bytes: Uint8Array): Promise<void> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const write = this.write(key, bytes).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, write);
    return write;
  }

  private async write(key: string, bytes: Uint8Array): Promise<void> {
    await this.store.put(this.keyFor(key), bytes, { contentType: "image/png" });
  }

  /**
   * Best-effort, and silent, exactly as the fs adapter is: an entry we cannot
   * delete is still a miss, and the caller regenerates either way. It is kept
   * as a `try` rather than a plain `delete` because the fs twin catches here
   * too, and a corrupt entry that cannot be removed must not fail a run over
   * something the run was only going to throw away.
   */
  private async deleteCorrupt(objectKey: ObjectKey): Promise<void> {
    try {
      await this.store.delete(objectKey);
    } catch {
      /* best-effort delete of a corrupt entry */
    }
  }

  /**
   * sha256 hex only, lower-cased, joined onto the prefix. The shape is the fs
   * adapter's rule and its refusal: a key that is not a digest is refused here
   * rather than sanitised, because sanitising it would let two different bad
   * keys name one entry.
   */
  private keyFor(key: string): ObjectKey {
    if (!/^[0-9a-f]{64}$/i.test(key)) {
      throw new Error("Background cache key must be a sha256 hex digest.");
    }
    const objectKey = `${this.prefix}${key.toLowerCase()}.png`;
    assertObjectKey(objectKey);
    return objectKey;
  }
}
