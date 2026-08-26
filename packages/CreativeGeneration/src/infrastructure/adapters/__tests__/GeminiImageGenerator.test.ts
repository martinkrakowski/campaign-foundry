import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  AspectRatio,
  type BackgroundCachePort,
  type ImageGeneratorPort,
} from "@campaignfoundry/CampaignOrchestration";
import { backgroundCacheKey } from "../FileSystemBackgroundCache.js";
import { GeminiImageGenerator, type ImagenClient } from "../GeminiImageGenerator.js";

const ratio = (v = "1:1") => {
  const r = AspectRatio.create(v);
  if (!r.success) throw r.error;
  return r.value;
};
const ctx = { campaignMessage: "m", targetAudience: "Urban", targetRegion: "DE" };
const product = { id: "hydra", name: "Hydra Bottle", primaryColor: "#1473E6", logoPath: "x.png" };
const fallback = (): ImageGeneratorPort => ({
  resolveBackground: vi.fn(async () => ({ image: new Uint8Array([7]), source: "procedural" as const })),
});

/** Mirrors the `generateImages` argument shape so `.mock.calls[0][0]` is typed. */
type GenArgs = { model: string; prompt: string; config: { numberOfImages: number; aspectRatio: string } };

beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe("GeminiImageGenerator", () => {
  test("returns an imagen-sourced image and builds a personalized prompt", async () => {
    const generateImages = vi.fn(async (_args: GenArgs) => ({
      generatedImages: [{ image: { imageBytes: Buffer.from("hello").toString("base64") } }],
    }));
    const client: ImagenClient = { models: { generateImages } };
    const out = await new GeminiImageGenerator({ apiKey: "k", client }).resolveBackground(product, ratio("9:16"), ctx);

    expect(out.source).toBe("imagen");
    expect(Buffer.from(out.image).toString()).toBe("hello");
    const args = generateImages.mock.calls[0][0];
    expect(args.config.aspectRatio).toBe("9:16");
    expect(args.model).toBe("imagen-4.0-generate-001");
    expect(args.prompt).toContain("Hydra Bottle");
    expect(args.prompt).toContain("DE");
  });

  test("honours a custom model id", async () => {
    const generateImages = vi.fn(async (_args: GenArgs) => ({ generatedImages: [{ image: { imageBytes: "AA==" } }] }));
    await new GeminiImageGenerator({ apiKey: "k", model: "imagen-x", client: { models: { generateImages } } }).resolveBackground(
      product,
      ratio(),
      ctx,
    );
    expect(generateImages.mock.calls[0][0].model).toBe("imagen-x");
  });

  test("constructs a real client when none is injected", () => {
    expect(() => new GeminiImageGenerator({ apiKey: "k" })).not.toThrow();
  });

  test("falls back when Imagen returns no image data", async () => {
    const client: ImagenClient = { models: { generateImages: vi.fn(async () => ({ generatedImages: [{ image: {} }] })) } };
    const fb = fallback();
    const out = await new GeminiImageGenerator({ apiKey: "k", client, fallback: fb }).resolveBackground(product, ratio(), ctx);
    expect(out.source).toBe("procedural");
    expect(fb.resolveBackground).toHaveBeenCalledTimes(1);
  });

  test("falls back when the client rejects with a non-Error reason", async () => {
    const client: ImagenClient = {
      models: {
        generateImages: vi.fn(async () => {
          throw "rate limited";
        }),
      },
    };
    const out = await new GeminiImageGenerator({ apiKey: "k", client, fallback: fallback() }).resolveBackground(
      product,
      ratio(),
      ctx,
    );
    expect(out.source).toBe("procedural");
  });

  test("serves a seed-cache hit without calling the client", async () => {
    const generateImages = vi.fn(async (_args: GenArgs) => ({
      generatedImages: [{ image: { imageBytes: "AA==" } }],
    }));
    const cache: BackgroundCachePort = {
      get: vi.fn(async () => new Uint8Array([9, 9])),
      set: vi.fn(),
    };
    const out = await new GeminiImageGenerator({
      apiKey: "k",
      client: { models: { generateImages } },
      cache,
    }).resolveBackground(product, ratio(), { ...ctx, seed: 7 });
    expect(out).toEqual({ image: new Uint8Array([9, 9]), source: "imagen", cached: true });
    expect(generateImages).not.toHaveBeenCalled();
    expect(vi.mocked(cache.get).mock.calls[0][0]).toMatch(/^[0-9a-f]{64}$/);
  });

  test("stores a seed-cache miss after a live fetch", async () => {
    const generateImages = vi.fn(async (_args: GenArgs) => ({
      generatedImages: [{ image: { imageBytes: Buffer.from("live").toString("base64") } }],
    }));
    const cache: BackgroundCachePort = { get: vi.fn(async () => undefined), set: vi.fn() };
    const out = await new GeminiImageGenerator({
      apiKey: "k",
      client: { models: { generateImages } },
      cache,
    }).resolveBackground(product, ratio(), { ...ctx, seed: 7 });
    expect(Buffer.from(out.image).toString()).toBe("live");
    expect(out.cached).toBeUndefined();
    expect(cache.set).toHaveBeenCalledTimes(1);
    const key = vi.mocked(cache.set).mock.calls[0][0];
    expect(key).toBe(
      backgroundCacheKey("imagen", "imagen-4.0-generate-001", generateImages.mock.calls[0][0].prompt, "1:1", 7),
    );
  });

  test("rethrows when the client fails and there is no fallback", async () => {
    const client: ImagenClient = {
      models: {
        generateImages: vi.fn(async () => {
          throw new Error("boom");
        }),
      },
    };
    await expect(
      new GeminiImageGenerator({ apiKey: "k", client }).resolveBackground(product, ratio(), ctx),
    ).rejects.toThrow("boom");
  });
});
