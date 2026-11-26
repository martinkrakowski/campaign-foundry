import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { createCanvas, loadImage } from "@napi-rs/canvas";
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
  resolveBackground: vi.fn(async () => ({
    image: new Uint8Array([7]),
    source: "procedural" as const,
  })),
});

/** Mirrors the `generateImages` argument shape so `.mock.calls[0][0]` is typed. */
type GenArgs = {
  model: string;
  prompt: string;
  config: { numberOfImages: number; aspectRatio: string; abortSignal?: AbortSignal };
};

beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe("GeminiImageGenerator", () => {
  test("returns an imagen-sourced image and builds a personalized prompt", async () => {
    const generateImages = vi.fn(async (_args: GenArgs) => ({
      generatedImages: [{ image: { imageBytes: Buffer.from("hello").toString("base64") } }],
    }));
    const client: ImagenClient = { models: { generateImages } };
    const out = await new GeminiImageGenerator({ apiKey: "k", client }).resolveBackground(
      product,
      ratio("9:16"),
      ctx,
    );

    expect(out.source).toBe("imagen");
    expect(Buffer.from(out.image).toString()).toBe("hello");
    const args = generateImages.mock.calls[0][0];
    expect(args.config.aspectRatio).toBe("9:16");
    expect(args.model).toBe("imagen-4.0-generate-001");
    expect(args.prompt).toContain("Hydra Bottle");
    expect(args.prompt).toContain("DE");
  });

  test("honours a custom model id", async () => {
    const generateImages = vi.fn(async (_args: GenArgs) => ({
      generatedImages: [{ image: { imageBytes: "AA==" } }],
    }));
    await new GeminiImageGenerator({
      apiKey: "k",
      model: "imagen-x",
      client: { models: { generateImages } },
    }).resolveBackground(product, ratio(), ctx);
    expect(generateImages.mock.calls[0][0].model).toBe("imagen-x");
  });

  test("constructs a real client when none is injected", () => {
    expect(() => new GeminiImageGenerator({ apiKey: "k" })).not.toThrow();
  });

  test("falls back when Imagen returns no image data", async () => {
    const client: ImagenClient = {
      models: { generateImages: vi.fn(async () => ({ generatedImages: [{ image: {} }] })) },
    };
    const fb = fallback();
    const out = await new GeminiImageGenerator({
      apiKey: "k",
      client,
      fallback: fb,
    }).resolveBackground(product, ratio(), ctx);
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
    const out = await new GeminiImageGenerator({
      apiKey: "k",
      client,
      fallback: fallback(),
    }).resolveBackground(product, ratio(), ctx);
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
      backgroundCacheKey(
        "imagen",
        "imagen-4.0-generate-001",
        generateImages.mock.calls[0][0].prompt,
        "1:1",
        7,
      ),
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

  test("pins the prompt shape, including the campaign-type sentence", async () => {
    const generateImages = vi.fn(async (_args: GenArgs) => ({
      generatedImages: [{ image: { imageBytes: "AA==" } }],
    }));
    const client: ImagenClient = { models: { generateImages } };
    const generator = new GeminiImageGenerator({ apiKey: "k", client });

    await generator.resolveBackground(product, ratio(), ctx);
    expect(generateImages.mock.calls[0][0].prompt).toBe(
      'Premium social-advertising hero background for the subject "Hydra Bottle". Audience: Urban. Market/region: DE. Evoke the brand accent colour #1473E6. Cinematic, photographic, high production value, with clean negative space toward the bottom for a headline. Absolutely no text, words, letters, logos or watermarks in the image. Campaign type: a social post for organic feeds.',
    );

    await generator.resolveBackground(product, ratio(), { ...ctx, campaignType: "paid-social" });
    expect(generateImages.mock.calls[1][0].prompt).toBe(
      'Premium social-advertising hero background for the subject "Hydra Bottle". Audience: Urban. Market/region: DE. Evoke the brand accent colour #1473E6. Cinematic, photographic, high production value, with clean negative space toward the bottom for a headline. Absolutely no text, words, letters, logos or watermarks in the image. Campaign type: paid social advertising across feeds, stories and reels.',
    );
  });

  test("maps 4:5 to Imagen's 3:4 and cover-fits the result to 1080x1350", async () => {
    // A REAL PNG: cover-fit decodes the bytes, so a stub like "hello" would throw.
    // The source is a patterned 768x1024 (3:4) — red outside the 4:5 crop at the
    // top, green above the vertical midpoint, blue below it, yellow outside the
    // crop at the bottom — so every cover-fit property is readable off the pixels.
    const source = createCanvas(768, 1024).getContext("2d");
    source.fillStyle = "#FF0000";
    source.fillRect(0, 0, 768, 32); // top 32 rows — cropped away
    source.fillStyle = "#00FF00";
    source.fillRect(0, 32, 768, 480); // upper visible half
    source.fillStyle = "#0000FF";
    source.fillRect(0, 512, 768, 480); // lower visible half
    source.fillStyle = "#FFFF00";
    source.fillRect(0, 992, 768, 32); // bottom 32 rows — cropped away
    const imagenPng = source.canvas.toBuffer("image/png").toString("base64");
    const generateImages = vi.fn(async (_args: GenArgs) => ({
      generatedImages: [{ image: { imageBytes: imagenPng } }],
    }));
    const out = await new GeminiImageGenerator({
      apiKey: "k",
      client: { models: { generateImages } },
    }).resolveBackground(product, ratio("4:5"), ctx);

    expect(generateImages.mock.calls[0][0].config.aspectRatio).toBe("3:4");
    const img = await loadImage(Buffer.from(out.image));
    expect(img.width).toBe(1080);
    expect(img.height).toBe(1350);
    const canvas = createCanvas(1080, 1350);
    const canvasCtx = canvas.getContext("2d");
    canvasCtx.drawImage(img, 0, 0);
    const data = canvasCtx.getImageData(0, 0, 1080, 1350).data;
    const pixel = (x: number, y: number): [number, number, number, number] => {
      const i = (y * 1080 + x) * 4;
      return [data[i], data[i + 1], data[i + 2], data[i + 3]];
    };

    // 768x1024 covers 1080x1350 at 1.40625x drawn at y = -45: exactly 32 source
    // rows fall outside the crop, top and bottom. Bilinear filtering blends one
    // pixel deep at each band edge, so edges assert channel dominance, not hex.
    const isGreen = ([r, g, b, a]: readonly number[]) => a === 255 && g > 150 && r < 100 && b < 100;
    const isBlue = ([r, g, b, a]: readonly number[]) => a === 255 && b > 150 && r < 100 && g < 100;

    // Top edge is visible-source green — never the cropped red band, and never
    // transparent. Contain-fit letterboxing or a shifted crop shows red here.
    for (const x of [0, 540, 1079]) {
      expect(isGreen(pixel(x, 0))).toBe(true);
    }
    // Bottom edge is visible-source blue — never the cropped yellow band.
    for (const x of [0, 540, 1079]) {
      expect(isBlue(pixel(x, 1349))).toBe(true);
    }
    // The centered crop puts the green/blue boundary exactly at output y = 675;
    // a stretched or vertically shifted draw moves it.
    expect(isGreen(pixel(540, 670))).toBe(true);
    expect(isBlue(pixel(540, 680))).toBe(true);
    // And nowhere on the canvas does a cropped band survive: zero red, zero
    // yellow, zero transparency. Stretching 768x1024 straight to 1080x1350
    // shows both cropped bands; contain-fit letterboxing shows transparency.
    let red = 0;
    let yellow = 0;
    let transparent = 0;
    for (let y = 0; y < 1350; y++) {
      for (let x = 0; x < 1080; x++) {
        const [r, g, b, a] = pixel(x, y);
        if (a < 255) transparent++;
        if (r > 200 && g < 100 && b < 100) red++;
        if (r > 200 && g > 200 && b < 100) yellow++;
      }
    }
    expect(red).toBe(0);
    expect(yellow).toBe(0);
    expect(transparent).toBe(0);
  });

  test("non-4:5 ratios pass through untouched with their own aspect ratio", async () => {
    for (const value of ["1:1", "9:16", "16:9"] as const) {
      const generateImages = vi.fn(async (_args: GenArgs) => ({
        generatedImages: [{ image: { imageBytes: Buffer.from("hello").toString("base64") } }],
      }));
      const out = await new GeminiImageGenerator({
        apiKey: "k",
        client: { models: { generateImages } },
      }).resolveBackground(product, ratio(value), ctx);
      expect(generateImages.mock.calls[0][0].config.aspectRatio).toBe(value);
      expect(Buffer.from(out.image).toString()).toBe("hello");
    }
  });
});

describe("GeminiImageGenerator — the run deadline (R5, D77)", () => {
  test("passes a signal to the SDK, and it follows the run", async () => {
    // Through the seam, because the SDK call is the only place a signal can
    // reach: this adapter makes no `fetch` of its own.
    const generateImages = vi.fn(async (_args: GenArgs) => ({
      generatedImages: [{ image: { imageBytes: "AA==" } }],
    }));
    const client: ImagenClient = { models: { generateImages } };
    const run = new AbortController();
    await new GeminiImageGenerator({ apiKey: "k", client }).resolveBackground(
      product,
      ratio("1:1"),
      ctx,
      run.signal,
    );
    const passed = generateImages.mock.calls[0]![0].config.abortSignal;
    expect(passed).toBeInstanceOf(AbortSignal);
    expect(passed!.aborted).toBe(false);
    run.abort(new Error("run abandoned"));
    expect(passed!.aborted).toBe(true);
  });

  test("still passes one when the caller has no run to bound", async () => {
    // The CLI runs without a job, so there is no run signal — the per-request
    // ceiling must still apply, or that path keeps the old unbounded behaviour.
    const generateImages = vi.fn(async (_args: GenArgs) => ({
      generatedImages: [{ image: { imageBytes: "AA==" } }],
    }));
    const client: ImagenClient = { models: { generateImages } };
    await new GeminiImageGenerator({ apiKey: "k", client }).resolveBackground(
      product,
      ratio("1:1"),
      ctx,
    );
    expect(generateImages.mock.calls[0]![0].config.abortSignal).toBeInstanceOf(AbortSignal);
  });
});
