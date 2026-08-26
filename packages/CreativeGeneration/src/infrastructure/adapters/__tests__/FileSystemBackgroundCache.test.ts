import { describe, test, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackgroundCachePort } from "@campaignfoundry/CampaignOrchestration";
import {
  FileSystemBackgroundCache,
  backgroundCacheKey,
  resolveCachedBackground,
} from "../FileSystemBackgroundCache.js";

const hex = backgroundCacheKey("imagen", "m", "p", "1:1", 7);

describe("backgroundCacheKey", () => {
  test("is stable for the same five fields", () => {
    expect(backgroundCacheKey("imagen", "m", "p", "1:1", 7)).toBe(hex);
    expect(backgroundCacheKey("imagen", "m", "p", "1:1", 8)).not.toBe(hex);
  });
});

describe("resolveCachedBackground", () => {
  test("skips the cache when seed is absent", async () => {
    const cache: BackgroundCachePort = { get: vi.fn(), set: vi.fn() };
    const generate = vi.fn(async () => new Uint8Array([1]));
    const out = await resolveCachedBackground(
      cache,
      undefined,
      { provider: "imagen", model: "m", prompt: "p", ratio: "1:1" },
      generate,
      "imagen",
    );
    expect(out).toEqual({ image: new Uint8Array([1]), source: "imagen" });
    expect(cache.get).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  test("returns a hit without generating", async () => {
    const cache: BackgroundCachePort = {
      get: vi.fn(async () => new Uint8Array([9])),
      set: vi.fn(),
    };
    const generate = vi.fn(async () => new Uint8Array([1]));
    const out = await resolveCachedBackground(
      cache,
      7,
      { provider: "imagen", model: "m", prompt: "p", ratio: "1:1" },
      generate,
      "imagen",
    );
    expect(out).toEqual({ image: new Uint8Array([9]), source: "imagen", cached: true });
    expect(cache.get).toHaveBeenCalledWith(hex);
    expect(generate).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  });

  test("generates when no cache port is injected", async () => {
    const generate = vi.fn(async () => new Uint8Array([4]));
    const out = await resolveCachedBackground(
      undefined,
      7,
      { provider: "imagen", model: "m", prompt: "p", ratio: "1:1" },
      generate,
      "imagen",
    );
    expect(out.source).toBe("imagen");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  test("stores a miss after generating", async () => {
    const cache: BackgroundCachePort = {
      get: vi.fn(async () => undefined),
      set: vi.fn(),
    };
    const generate = vi.fn(async () => new Uint8Array([3]));
    const out = await resolveCachedBackground(
      cache,
      7,
      { provider: "imagen", model: "m", prompt: "p", ratio: "1:1" },
      generate,
      "imagen",
    );
    expect(out).toEqual({ image: new Uint8Array([3]), source: "imagen" });
    expect(cache.set).toHaveBeenCalledWith(hex, new Uint8Array([3]));
  });
});

describe("FileSystemBackgroundCache", () => {
  test("round-trips bytes under a temp root", async () => {
    const root = await mkdtemp(join(tmpdir(), "cf-bg-cache-"));
    try {
      const cache = new FileSystemBackgroundCache(root);
      expect(await cache.get(hex)).toBeUndefined();
      await cache.set(hex.toUpperCase(), new Uint8Array([1, 2, 3]));
      expect(Array.from((await cache.get(hex)) ?? [])).toEqual([1, 2, 3]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a non-hex key", async () => {
    const root = await mkdtemp(join(tmpdir(), "cf-bg-cache-"));
    try {
      const cache = new FileSystemBackgroundCache(root);
      await expect(cache.set("../evil", new Uint8Array([1]))).rejects.toThrow(/sha256 hex/);
      await expect(cache.get("not-hex")).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
