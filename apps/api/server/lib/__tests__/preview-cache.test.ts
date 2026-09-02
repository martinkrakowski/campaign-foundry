import { describe, test, expect } from "vitest";
import { LruCache } from "../preview-cache.js";

describe("LruCache", () => {
  test("returns undefined for a missing key and stores what is set", () => {
    const cache = new LruCache<string>(2);
    expect(cache.get("a")).toBeUndefined();
    cache.set("a", "one");
    expect(cache.get("a")).toBe("one");
  });

  test("a get refreshes recency, so the coldest entry is evicted, not the last read", () => {
    const cache = new LruCache<string>(2);
    cache.set("a", "one");
    cache.set("b", "two");
    expect(cache.get("a")).toBe("one"); // b is now the coldest
    cache.set("c", "three");
    expect(cache.get("a")).toBe("one");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe("three");
  });

  test("re-setting a key does not evict it as a duplicate", () => {
    const cache = new LruCache<string>(2);
    cache.set("a", "one");
    cache.set("b", "two");
    cache.set("a", "uno"); // refresh + overwrite
    cache.set("c", "three");
    expect(cache.get("a")).toBe("uno");
    expect(cache.get("b")).toBeUndefined();
  });

  test("clear empties the cache", () => {
    const cache = new LruCache<string>(2);
    cache.set("a", "one");
    cache.clear();
    expect(cache.get("a")).toBeUndefined();
  });
});
