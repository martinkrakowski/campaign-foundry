import { createHash } from "node:crypto";
import { describe, test, expect, vi } from "vitest";
import {
  compositeRequestFingerprint,
  PreviewCreativeFrameUseCase,
} from "../PreviewCreativeFrameUseCase.use-case.js";
import type {
  PreviewCreativeFrameDeps,
  PreviewFrameCache,
  PreviewFrameCacheEntry,
} from "../PreviewCreativeFrameUseCase.use-case.js";
import type { PlatformSafeZone, PlatformSafeZoneResolver } from "../../ports/out/PlatformProfilePort.js";
import type { CampaignBrief } from "../../../domain/entities/CampaignBrief.js";
import type { Product } from "../../../domain/entities/Product.js";
import { fakeCompositor, fakeImageGenerator } from "./_fakes.js";

/** The same sha256 the composition root injects — real hashing, real keys. */
const sha256 = (input: string | Uint8Array): string =>
  createHash("sha256").update(input).digest("hex");

const product = (id: string, over: Partial<Product> = {}): Product => ({
  id,
  name: id,
  primaryColor: "#1473E6",
  logoPath: `assets/inputs/${id}.png`,
  ...over,
});

const baseBrief = (over: Partial<CampaignBrief> = {}): CampaignBrief => ({
  id: "camp",
  targetRegion: "DE",
  targetAudience: "audience",
  campaignMessage: "Hello",
  localizedMessage: "Hallo",
  products: [product("alpha")],
  ...over,
});

const cell = (over: Record<string, unknown> = {}) => ({
  productId: "alpha",
  ratio: "9:16",
  layout: "headline-bottom" as const,
  tone: "bold" as const,
  ...over,
});

const memoryCache = (): PreviewFrameCache & { store: Map<string, PreviewFrameCacheEntry> } => {
  const store = new Map<string, PreviewFrameCacheEntry>();
  return {
    store,
    get: (key) => store.get(key),
    set: (key, entry) => void store.set(key, entry),
  };
};

const deps = (over: Partial<PreviewCreativeFrameDeps> = {}): PreviewCreativeFrameDeps => ({
  imageGenerator: fakeImageGenerator("procedural"),
  compositor: fakeCompositor(),
  hash: sha256,
  ...over,
});

/** A zone resolver that answers for one platform, so the D11 inset union is exercised. */
const oneZoneResolver = (): PlatformSafeZoneResolver => {
  const zone: PlatformSafeZone = {
    ratio: "9:16",
    safeInsets: { top: 140, right: 40, bottom: 100, left: 40 },
    formats: ["static"],
  };
  return (id: string) => (id === "instagram-story" ? zone : undefined);
};

describe("PreviewCreativeFrameUseCase — cell validation", () => {
  test("rejects a cell naming a product the brief does not carry, before any port is called", async () => {
    const d = deps();
    const result = await new PreviewCreativeFrameUseCase(d).execute(baseBrief(), cell({ productId: "ghost" }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(/unknown product "ghost"/);
    expect(d.imageGenerator.resolveBackground).not.toHaveBeenCalled();
    expect(d.compositor.compositeAsset).not.toHaveBeenCalled();
  });

  test("rejects a ratio outside the axis vocabulary, before any port is called", async () => {
    const d = deps();
    const result = await new PreviewCreativeFrameUseCase(d).execute(baseBrief(), cell({ ratio: "4:3" }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(/Unsupported aspect ratio "4:3"/);
    expect(d.imageGenerator.resolveBackground).not.toHaveBeenCalled();
    expect(d.compositor.compositeAsset).not.toHaveBeenCalled();
  });
});

describe("PreviewCreativeFrameUseCase — the request mirrors the run", () => {
  test("builds the composite request the way the run builds it: localized copy, context, no forked math", async () => {
    const d = deps();
    const result = await new PreviewCreativeFrameUseCase(d).execute(baseBrief(), cell());
    expect(result.success).toBe(true);
    expect(d.imageGenerator.resolveBackground).toHaveBeenCalledWith(
      product("alpha"),
      expect.objectContaining({ value: "9:16", width: 1080, height: 1920 }),
      {
        campaignMessage: "Hello",
        targetAudience: "audience",
        targetRegion: "DE",
      },
    );
    expect(d.compositor.compositeAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Hallo", // LocalizedMessageFallback — exactly the run's rule
        brandColor: "#1473E6",
        logoPath: "assets/inputs/alpha.png",
        layout: "headline-bottom",
        tone: "bold",
      }),
    );
  });

  test("falls back to the campaign message when no localized message exists", async () => {
    const d = deps();
    await new PreviewCreativeFrameUseCase(d).execute(baseBrief({ localizedMessage: undefined }), cell());
    expect(d.compositor.compositeAsset).toHaveBeenCalledWith(expect.objectContaining({ message: "Hello" }));
  });

  test("carries the anchor only when the cell names one — absent stays absent", async () => {
    const d = deps();
    await new PreviewCreativeFrameUseCase(d).execute(baseBrief(), cell({ anchor: "top" }));
    expect(d.compositor.compositeAsset).toHaveBeenCalledWith(expect.objectContaining({ anchor: "top" }));

    const without = deps();
    await new PreviewCreativeFrameUseCase(without).execute(baseBrief(), cell());
    const request = vi.mocked(without.compositor.compositeAsset).mock.calls[0][0];
    expect("anchor" in request).toBe(false);
  });

  test("passes the platform safe-inset union for the requested ratio (D11), and nothing for unknown platforms", async () => {
    const d = deps({ platformSafeZones: oneZoneResolver() });
    await new PreviewCreativeFrameUseCase(d).execute(
      baseBrief({ output: { formats: ["static"], platforms: ["instagram-story"] } }),
      cell(),
    );
    expect(d.compositor.compositeAsset).toHaveBeenCalledWith(
      expect.objectContaining({ safeInsets: { top: 140, right: 40, bottom: 100, left: 40 } }),
    );

    const unlisted = deps({ platformSafeZones: oneZoneResolver() });
    await new PreviewCreativeFrameUseCase(unlisted).execute(
      baseBrief({ output: { formats: ["static"], platforms: ["not-a-platform"] } }),
      cell(),
    );
    const request = vi.mocked(unlisted.compositor.compositeAsset).mock.calls[0][0];
    expect("safeInsets" in request).toBe(false);
  });
});

describe("PreviewCreativeFrameUseCase — the frame and its cache key", () => {
  test("returns the composited bytes with the compositor's logo verdict and provenance", async () => {
    const d = deps({ compositor: fakeCompositor(false) });
    const result = await new PreviewCreativeFrameUseCase(d).execute(baseBrief(), cell());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.image).toEqual(new Uint8Array([4, 5, 6]));
    expect(result.value.logoApplied).toBe(false);
    expect(result.value.ratio).toBe("9:16");
    expect(result.value.backgroundSource).toBe("procedural");
    expect(result.value.cacheKey).toMatch(/^[a-f0-9]{64}$/);
  });

  test("the cache key is a stable hash of the FULL composite request, the background entering as a content hash of its bytes", async () => {
    const d = deps();
    const first = await new PreviewCreativeFrameUseCase(d).execute(baseBrief(), cell());
    const again = await new PreviewCreativeFrameUseCase(deps()).execute(baseBrief(), cell());
    expect(first.success && again.success).toBe(true);
    if (!first.success || !again.success) return;
    // Deterministic across use-case instances: identical requests hash equal.
    expect(again.value.cacheKey).toBe(first.value.cacheKey);

    // A different background (different bytes out of the port) can never collide —
    // the key is content-addressed, not identity-addressed (mutation check c).
    const otherBackground = deps({ imageGenerator: fakeImageGenerator() });
    otherBackground.imageGenerator.resolveBackground = vi.fn(async () => ({
      image: new Uint8Array([9, 9, 9]),
      source: "procedural" as const,
    }));
    const shifted = await new PreviewCreativeFrameUseCase(otherBackground).execute(baseBrief(), cell());
    // The tripwire must not be able to pass vacuously: a failed execute here is a
    // broken fixture, not a pass (CodeRabbit, PR #177).
    expect(shifted.success).toBe(true);
    if (!shifted.success) return;
    expect(shifted.value.cacheKey).not.toBe(first.value.cacheKey);

    // And the fingerprint pins every field: one changed field moves the key.
    const request = vi.mocked(d.compositor.compositeAsset).mock.calls[0][0];
    const twin = { ...request, tone: "subtle" as const };
    expect(compositeRequestFingerprint(twin, sha256)).not.toBe(first.value.cacheKey);
  });

  test("a cache hit returns the stored bytes without compositing again; a miss stores them", async () => {
    const cache = memoryCache();
    const d = deps({ frameCache: cache });
    await new PreviewCreativeFrameUseCase(d).execute(baseBrief(), cell());
    expect(cache.store.size).toBe(1);

    const second = deps({ frameCache: cache });
    const result = await new PreviewCreativeFrameUseCase(second).execute(baseBrief(), cell());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(second.compositor.compositeAsset).not.toHaveBeenCalled();
    expect(result.value.image).toEqual(new Uint8Array([4, 5, 6]));
    expect(result.value.logoApplied).toBe(true);
  });

  test("works without a cache wired — the frame is composited every time", async () => {
    const d = deps();
    await new PreviewCreativeFrameUseCase(d).execute(baseBrief(), cell());
    const result = await new PreviewCreativeFrameUseCase(d).execute(baseBrief(), cell());
    expect(vi.mocked(d.compositor.compositeAsset)).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
  });
});

test("the template's style block rides the frame request exactly as it rides the run (D45)", async () => {
  const d = deps();
  const styled = { ...baseBrief(), style: { fontFamily: "Lora" as const, sizeScale: 0.08 } };
  const result = await new PreviewCreativeFrameUseCase(d).execute(styled, cell());
  expect(result.success).toBe(true);
  expect(d.compositor.compositeAsset).toHaveBeenCalledWith(
    expect.objectContaining({ style: { fontFamily: "Lora", sizeScale: 0.08 } }),
  );

  // And absent stays absent — the key must not appear for a style-less brief.
  const d2 = deps();
  await new PreviewCreativeFrameUseCase(d2).execute(baseBrief(), cell());
  const plainRequest = vi.mocked(d2.compositor.compositeAsset).mock.calls[0][0];
  expect("style" in plainRequest).toBe(false);
});
