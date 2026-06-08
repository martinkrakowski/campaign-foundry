import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { AspectRatio, type ImageGeneratorPort } from "@campaignfoundry/CampaignOrchestration";
import { OpenRouterImageGenerator } from "../OpenRouterImageGenerator.js";

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

/** A real 4×4 PNG so the adapter's loadImage/cover-fit step works. */
const pngBase64 = (): string => {
  const c = createCanvas(4, 4);
  const g = c.getContext("2d");
  g.fillStyle = "#1473E6";
  g.fillRect(0, 0, 4, 4);
  return c.toBuffer("image/png").toString("base64");
};
const pngDataUrl = (): string => `data:image/png;base64,${pngBase64()}`;

/** Minimal fetch Response stand-in. */
const res = (opts: { ok?: boolean; status?: number; json?: unknown; text?: string }): Response =>
  ({
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => opts.json,
    text: async () => opts.text ?? "",
  }) as unknown as Response;

const messageWith = (message: unknown) => ({ choices: [{ message }] });

let fetchMock: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchMock = vi.spyOn(globalThis, "fetch");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("OpenRouterImageGenerator", () => {
  test("returns an openrouter-sourced, cover-fitted image and maps the aspect ratio", async () => {
    fetchMock.mockResolvedValueOnce(res({ json: messageWith({ images: [{ image_url: { url: pngDataUrl() } }] }) }));
    const out = await new OpenRouterImageGenerator({ apiKey: "k" }).resolveBackground(product, ratio("16:9"), ctx);

    expect(out.source).toBe("openrouter");
    expect(Array.from(out.image.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.image_config.aspect_ratio).toBe("3:2"); // 16:9 → nearest OpenRouter ratio
    expect(body.modalities).toEqual(["image"]);
  });

  test("reads an image from images[].url when image_url is absent", async () => {
    fetchMock.mockResolvedValueOnce(res({ json: messageWith({ images: [{ url: pngDataUrl() }] }) }));
    const out = await new OpenRouterImageGenerator({ apiKey: "k" }).resolveBackground(product, ratio(), ctx);
    expect(out.source).toBe("openrouter");
  });

  test("reads an image from the content[] array, skipping non-image parts", async () => {
    fetchMock.mockResolvedValueOnce(
      res({ json: messageWith({ content: [{ foo: 1 }, { image_url: { url: pngDataUrl() } }] }) }),
    );
    const out = await new OpenRouterImageGenerator({ apiKey: "k" }).resolveBackground(product, ratio(), ctx);
    expect(out.source).toBe("openrouter");
  });

  test("honours a custom model id", async () => {
    fetchMock.mockResolvedValueOnce(res({ json: messageWith({ images: [{ image_url: { url: pngDataUrl() } }] }) }));
    await new OpenRouterImageGenerator({ apiKey: "k", model: "x-ai/custom" }).resolveBackground(product, ratio(), ctx);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.model).toBe("x-ai/custom");
  });

  test("falls back when fetch rejects with a non-Error reason", async () => {
    fetchMock.mockRejectedValueOnce("kaput");
    const out = await new OpenRouterImageGenerator({ apiKey: "k", fallback: fallback() }).resolveBackground(product, ratio(), ctx);
    expect(out.source).toBe("procedural");
  });

  test("decodes a bare base64 payload (no data-url comma)", async () => {
    fetchMock.mockResolvedValueOnce(res({ json: messageWith({ images: [{ url: pngBase64() }] }) }));
    const out = await new OpenRouterImageGenerator({ apiKey: "k" }).resolveBackground(product, ratio(), ctx);
    expect(out.source).toBe("openrouter");
  });

  test("retries with image+text modalities on a modality-mismatch error", async () => {
    fetchMock
      .mockResolvedValueOnce(res({ ok: false, status: 400, text: "unsupported modalities for this model" }))
      .mockResolvedValueOnce(res({ json: messageWith({ images: [{ image_url: { url: pngDataUrl() } }] }) }));
    const out = await new OpenRouterImageGenerator({ apiKey: "k" }).resolveBackground(product, ratio(), ctx);

    expect(out.source).toBe("openrouter");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(retryBody.modalities).toEqual(["image", "text"]);
  });

  test("falls back on a non-modality HTTP error", async () => {
    fetchMock.mockResolvedValueOnce(res({ ok: false, status: 500, text: "server boom" }));
    const fb = fallback();
    const out = await new OpenRouterImageGenerator({ apiKey: "k", fallback: fb }).resolveBackground(product, ratio(), ctx);
    expect(out.source).toBe("procedural");
    expect(fb.resolveBackground).toHaveBeenCalledTimes(1);
  });

  test("falls back when the response carries no image", async () => {
    fetchMock.mockResolvedValueOnce(res({ json: messageWith({}) }));
    const out = await new OpenRouterImageGenerator({ apiKey: "k", fallback: fallback() }).resolveBackground(product, ratio(), ctx);
    expect(out.source).toBe("procedural");
  });

  test("rethrows when fetch rejects and there is no fallback", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await expect(
      new OpenRouterImageGenerator({ apiKey: "k" }).resolveBackground(product, ratio(), ctx),
    ).rejects.toThrow("network down");
  });

  test("defaults an unmapped ratio to a 1:1 request", async () => {
    fetchMock.mockResolvedValueOnce(res({ json: messageWith({ images: [{ image_url: { url: pngDataUrl() } }] }) }));
    const oddRatio = { value: "4:3", width: 100, height: 100 } as unknown as AspectRatio;
    await new OpenRouterImageGenerator({ apiKey: "k" }).resolveBackground(product, oddRatio, ctx);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.image_config.aspect_ratio).toBe("1:1");
  });
});
