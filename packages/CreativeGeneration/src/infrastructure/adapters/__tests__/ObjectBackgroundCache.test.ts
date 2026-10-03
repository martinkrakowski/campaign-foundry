import { describe, test, expect, beforeEach, vi } from "vitest";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { backgroundCacheKey } from "../FileSystemBackgroundCache.js";
import { ObjectBackgroundCache } from "../ObjectBackgroundCache.js";

const PREFIX = "org/acme/cache/";
const hex = backgroundCacheKey("imagen", "m", "p", "1:1", 7);
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const pngBytes = (...rest: number[]) => new Uint8Array([...PNG_SIG, ...rest]);
const keyFor = (digest: string) => `${PREFIX}${digest.toLowerCase()}.png`;
const listedKeys = (store: InMemoryObjectStore, prefix = PREFIX) =>
  store.list(prefix).then((entries) => entries.map((entry) => entry.key));

describe("ObjectBackgroundCache", () => {
  let store: InMemoryObjectStore;
  let cache: ObjectBackgroundCache;

  beforeEach(() => {
    store = new InMemoryObjectStore();
    cache = new ObjectBackgroundCache(store, PREFIX);
  });

  test("round-trips PNG bytes under the org's prefix, stored as image/png", async () => {
    expect(await cache.get(hex)).toBeUndefined();
    const bytes = pngBytes(1, 2, 3);
    await cache.set(hex.toUpperCase(), bytes);
    // Upper case in, lower case at the key — the same normalisation the fs
    // adapter does, so one entry is reachable under either spelling.
    expect(Buffer.from((await cache.get(hex))!).equals(Buffer.from(bytes))).toBe(true);
    const stored = await store.head(keyFor(hex));
    expect(stored!.size).toBe(bytes.length);
    expect(stored!.contentType).toBe("image/png");
  });

  test("refuses a key that is not a sha256 hex digest on set, and misses on get", async () => {
    // The refusal is what keeps a bad key from naming anything: sanitising it
    // instead would let two different bad keys collide on one entry.
    await expect(cache.set("../evil", pngBytes(1))).rejects.toThrow(/sha256 hex/);
    await expect(cache.get("not-hex")).resolves.toBeUndefined();
    expect(await listedKeys(store)).toEqual([]);
  });

  test("a refused set does not poison the next write of a good key", async () => {
    // The in-flight entry is released in `finally`, so a rejected `set` is
    // forgotten rather than remembered as done — otherwise the refusal above
    // would be cached against this key forever and no image would ever be
    // cached again for this process.
    await expect(cache.set("nope", pngBytes(1))).rejects.toThrow();
    await cache.set(hex, pngBytes(4));
    expect(Buffer.from((await cache.get(hex))!).equals(Buffer.from(pngBytes(4)))).toBe(true);
  });

  test("treats a non-PNG or trivial entry as a miss and deletes it", async () => {
    await store.put(keyFor(hex), new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(await cache.get(hex)).toBeUndefined();
    // The delete is the point: the corrupt entry is gone, so the NEXT set is a
    // plain write rather than a conditional create against rubbish.
    expect(await store.get(keyFor(hex))).toBeUndefined();

    // The signature alone is not an image either — the length is part of the test.
    await store.put(keyFor(hex), new Uint8Array(PNG_SIG));
    expect(await cache.get(hex)).toBeUndefined();
    expect(await store.get(keyFor(hex))).toBeUndefined();
  });

  test("a failed delete of a corrupt entry is still a miss", async () => {
    // Best-effort by design: an entry we cannot remove is not something the
    // caller can act on, and failing the run over it would be worse than the
    // corrupt bytes it is throwing away.
    await store.put(keyFor(hex), new Uint8Array([1, 2, 3]));
    vi.spyOn(store, "delete").mockRejectedValue(new Error("access denied"));
    expect(await cache.get(hex)).toBeUndefined();
  });

  test("de-duplicates in-flight sets of one key into ONE put", async () => {
    // A run renders eight cells at a time and the reuse wrapper resolves the
    // same background for each, so without this one prompt's image is uploaded
    // eight times. The window is the point: both callers must get the SAME
    // promise, which a map written after the first await would not give.
    let releasePut: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    const put = vi.spyOn(store, "put").mockImplementation(async (key, bytes, options) => {
      await gate;
      await InMemoryObjectStore.prototype.put.call(store, key, bytes, options);
    });
    const bytes = pngBytes(9, 9);
    const first = cache.set(hex, bytes);
    const second = cache.set(hex, bytes);
    expect(second).toBe(first);
    releasePut();
    await Promise.all([first, second]);
    expect(put).toHaveBeenCalledTimes(1);

    // A THIRD set, once the window has closed, is a new put: the entry was
    // released in `finally`, not remembered as done.
    await cache.set(hex, bytes);
    expect(put).toHaveBeenCalledTimes(2);
    expect(Buffer.from((await cache.get(hex))!).equals(Buffer.from(bytes))).toBe(true);
  });

  test("a get the store cannot answer is a MISS, not a failed run", async () => {
    // As on fs, where a missing file and an unreadable one both answer
    // undefined: an entry that cannot be read is not a hit, and the caller
    // regenerates either way.
    await store.put(keyFor(hex), pngBytes(1));
    vi.spyOn(store, "get").mockRejectedValue(new Error("connection reset"));
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await cache.get(hex)).toBeUndefined();
      // Not even a warning: this is an ordinary miss, and a run must not log one
      // for regenerating an image it did not have.
      expect(warned).not.toHaveBeenCalled();
    } finally {
      warned.mockRestore();
    }
  });

  test("two orgs never share an entry: the same key is absent in the other org", async () => {
    const acme = new ObjectBackgroundCache(store, "org/acme/cache/");
    const globex = new ObjectBackgroundCache(store, "org/globex/cache/");
    await acme.set(hex, pngBytes(1));
    expect(await globex.get(hex)).toBeUndefined();
    // The prompt is user-authored, so a shared cache would be a cross-tenant
    // fingerprinting surface even where the bytes are identical.
    expect(await listedKeys(store, "org/")).toEqual([keyFor(hex)]);
  });
});
