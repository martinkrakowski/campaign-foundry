import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createRouter, toWebHandler, type EventHandler } from "h3";
import {
  AssetReusingImageGenerator,
  CanvasFfmpegVideoCompositor,
  FireflyImageGenerator,
  GeminiImageGenerator,
  NodeCanvasCompositor,
  OpenRouterImageGenerator,
  ProceduralBackgroundGenerator,
} from "@campaignfoundry/CreativeGeneration";
import route, {
  previewBackgroundGenerator,
  previewCompositor,
  previewFrameCache,
  previewVideoCompositor,
} from "../preview-frame.post.js";

const mount = () => {
  const app = createApp();
  const router = createRouter();
  router.post("/campaigns/preview-frame", route as EventHandler);
  app.use(router);
  return toWebHandler(app);
};

const brief = (primaryColor = "#1473E6") => ({
  id: "camp",
  targetRegion: "DE",
  targetAudience: "a",
  campaignMessage: "Hi",
  products: [{ id: "alpha", name: "A", primaryColor, logoPath: "assets/inputs/alpha-logo.png" }],
});

const cell = (over: Record<string, unknown> = {}) => ({
  productId: "alpha",
  canvas: { ratio: "9:16" },
  layout: "headline-bottom",
  tone: "bold",
  ...over,
});

const jsonReq = (body: unknown) =>
  new Request("http://x/campaigns/preview-frame", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** Canonical image-html: no shade, accent, or copy. Dropping the brief template makes the preview draw image-text instead. */
const imageHtmlTemplate = {
  id: "canonical-image-html",
  version: 1,
  creativeType: "image-html",
  unit: "standard-web",
  layers: [
    { id: "image", kind: "image" },
    { id: "html", kind: "html" },
    { id: "logo", kind: "logo" },
  ],
};

/** Image-text with the shade layer on, switched off, or left out of the list. */
const imageTextTemplate = (shade: "on" | "off" | "absent") => ({
  id: "canonical-image-text",
  version: 1,
  creativeType: "image-text",
  unit: "standard-web",
  layers: [
    { id: "image", kind: "image" },
    ...(shade === "absent"
      ? []
      : [{ id: "shade", kind: "shade", ...(shade === "off" ? { enabled: false } : {}) }]),
    { id: "accent", kind: "accent" },
    { id: "static-text", kind: "static-text" },
    { id: "logo", kind: "logo" },
  ],
});

/** A 1×1 transparent PNG, so the compositor's logo step has real bytes to load. */
const ONE_PX_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("POST /campaigns/preview-frame", () => {
  let dir: string;
  const origRoot = process.env.PROJECT_ROOT;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cf-preview-frame-"));
    mkdirSync(join(dir, "assets", "inputs"), { recursive: true });
    writeFileSync(join(dir, "assets", "inputs", "alpha-logo.png"), ONE_PX_PNG);
    process.env.PROJECT_ROOT = dir;
    previewFrameCache.clear();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (origRoot === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = origRoot;
  });

  test("returns image/png whose dimensions match the requested ratio, with the cache key in the header", async () => {
    const res = await mount()(jsonReq({ brief: brief(), cell: cell() }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const key = res.headers.get("x-preview-frame-cache-key");
    expect(key).toMatch(/^[a-f0-9]{64}$/);

    // Golden-adjacent sanity only (the compositor's own tests pin pixels):
    // the PNG decodes and its IHDR carries the 9:16 canvas dimensions.
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a"); // PNG signature
    expect(bytes.readUInt32BE(16)).toBe(1080);
    expect(bytes.readUInt32BE(20)).toBe(1920);
  });

  test("a display-size cell renders the exact pixel canvas, not a scaled ratio", async () => {
    const res = await mount()(
      jsonReq({ brief: brief(), cell: cell({ canvas: { size: "728x90" } }) }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const bytes = Buffer.from(await res.arrayBuffer());
    // The PNG's IHDR carries the display unit's own dimensions (D113: never scaled).
    expect(bytes.readUInt32BE(16)).toBe(728);
    expect(bytes.readUInt32BE(20)).toBe(90);
  });

  test("a cell carrying an anchor renders with it", async () => {
    const res = await mount()(jsonReq({ brief: brief(), cell: cell({ anchor: "top" }) }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  test("identical requests share one cache key", async () => {
    const web = mount();
    const first = await web(jsonReq({ brief: brief(), cell: cell() }));
    const second = await web(jsonReq({ brief: brief(), cell: cell() }));
    expect(second.headers.get("x-preview-frame-cache-key")).toBe(
      first.headers.get("x-preview-frame-cache-key"),
    );
  });

  test("two briefs with different backgrounds never collide (background enters the key as a content hash)", async () => {
    const web = mount();
    const red = await web(jsonReq({ brief: brief("#E0218A"), cell: cell() }));
    const blue = await web(jsonReq({ brief: brief("#1473E6"), cell: cell() }));
    expect(red.headers.get("x-preview-frame-cache-key")).toMatch(/^[a-f0-9]{64}$/);
    expect(blue.headers.get("x-preview-frame-cache-key")).not.toBe(
      red.headers.get("x-preview-frame-cache-key"),
    );
  });

  test("the frame renders with zero network calls — no generator other than the procedural one is reachable", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await mount()(jsonReq({ brief: brief(), cell: cell() }));
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("the route's generator is ProceduralBackgroundGenerator wired DIRECTLY — never the production chain (D52)", () => {
    expect(previewBackgroundGenerator).toBeInstanceOf(ProceduralBackgroundGenerator);
    // Every production-chain wrapper/provider is unreachable from the wiring:
    for (const chainLink of [
      AssetReusingImageGenerator,
      GeminiImageGenerator,
      OpenRouterImageGenerator,
      FireflyImageGenerator,
    ]) {
      expect(previewBackgroundGenerator).not.toBeInstanceOf(chainLink);
    }
    expect(previewCompositor).toBeInstanceOf(NodeCanvasCompositor);
    expect(previewVideoCompositor).toBeInstanceOf(CanvasFfmpegVideoCompositor);
  });

  test("a scrub cell with motion, durationSec, atSec renders image/png and returns cache key", async () => {
    const res = await mount()(
      jsonReq({
        brief: brief(),
        cell: cell({ motion: "ken-burns-in", durationSec: 6, atSec: 2 }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-preview-frame-cache-key")).toMatch(/^[a-f0-9]{64}$/);
  });

  test.each([
    ["a non-object brief", { brief: 42, cell: cell() }, /must be an object/],
    [
      "a brief missing a required field",
      { brief: { id: "camp" }, cell: cell() },
      /missing required field/,
    ],
  ])("rejects %s with 400", async (_label, body, message) => {
    const res = await mount()(jsonReq(body));
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringMatching(message),
    });
  });

  test.each([
    ["a non-object body", 42, /envelope/],
    ["a body without a brief", { cell: cell() }, /envelope/],
    ["a body without a cell", { brief: brief() }, /envelope/],
    ["a non-object cell", { brief: brief(), cell: "nope" }, /cell must be an object/],
    [
      "a cell without a productId",
      { brief: brief(), cell: cell({ productId: undefined }) },
      /productId/,
    ],
    ["a non-object canvas", { brief: brief(), cell: cell({ canvas: "728x90" }) }, /canvas/],
    [
      "a canvas carrying both families",
      { brief: brief(), cell: cell({ canvas: { ratio: "9:16", size: "728x90" } }) },
      /exactly one of ratio\/size/,
    ],
    [
      "a canvas carrying neither family",
      { brief: brief(), cell: cell({ canvas: {} }) },
      /exactly one of ratio\/size/,
    ],
    [
      "an unknown ratio",
      { brief: brief(), cell: cell({ canvas: { ratio: "4:3" } }) },
      /canvas ratio must be one of/,
    ],
    [
      "an unknown display size",
      { brief: brief(), cell: cell({ canvas: { size: "banner" } }) },
      /canvas size must be one of/,
    ],
    [
      "an unknown layout",
      { brief: brief(), cell: cell({ layout: "headline-left" }) },
      /layout must be one of/,
    ],
    ["an unknown tone", { brief: brief(), cell: cell({ tone: "loud" }) }, /tone must be one of/],
    [
      "an unknown anchor",
      { brief: brief(), cell: cell({ anchor: "left" }) },
      /anchor must be one of/,
    ],
    ["a non-string anchor", { brief: brief(), cell: cell({ anchor: 3 }) }, /anchor must be one of/],
    [
      "motion without durationSec and atSec",
      { brief: brief(), cell: cell({ motion: "ken-burns-in" }) },
      /motion, durationSec and atSec together/,
    ],
    [
      "durationSec without motion and atSec",
      { brief: brief(), cell: cell({ durationSec: 6 }) },
      /motion, durationSec and atSec together/,
    ],
    [
      "atSec without motion and durationSec",
      { brief: brief(), cell: cell({ atSec: 2 }) },
      /motion, durationSec and atSec together/,
    ],
    [
      "an unknown motion kind",
      { brief: brief(), cell: cell({ motion: "spin", durationSec: 6, atSec: 2 }) },
      /motion must be one of/,
    ],
    [
      "durationSec out of range",
      { brief: brief(), cell: cell({ motion: "ken-burns-in", durationSec: 35, atSec: 2 }) },
      /durationSec/,
    ],
    [
      "atSec out of range",
      { brief: brief(), cell: cell({ motion: "ken-burns-in", durationSec: 6, atSec: 8 }) },
      /atSec/,
    ],
  ])("rejects %s with 400", async (_label, body, message) => {
    const res = await mount()(jsonReq(body));
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringMatching(message),
    });
  });

  test("rejects a cell naming an unknown product with 400", async () => {
    const res = await mount()(jsonReq({ brief: brief(), cell: cell({ productId: "ghost" }) }));
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringMatching(/unknown product "ghost"/),
    });
  });

  test("an image-html brief previews different pixels than the image-text canonical", async () => {
    const web = mount();
    const html = await web(
      jsonReq({
        brief: { ...brief(), output: { formats: ["html"] }, template: imageHtmlTemplate },
        cell: cell(),
      }),
    );
    const text = await web(
      jsonReq({ brief: { ...brief(), template: imageTextTemplate("on") }, cell: cell() }),
    );
    expect(html.status).toBe(200);
    expect(text.status).toBe(200);
    expect(Buffer.from(await html.arrayBuffer())).not.toEqual(
      Buffer.from(await text.arrayBuffer()),
    );
  });

  test("a disabled shade previews the same pixels as a template that omits it", async () => {
    const web = mount();
    const off = await web(
      jsonReq({ brief: { ...brief(), template: imageTextTemplate("off") }, cell: cell() }),
    );
    const on = await web(
      jsonReq({ brief: { ...brief(), template: imageTextTemplate("on") }, cell: cell() }),
    );
    const absent = await web(
      jsonReq({ brief: { ...brief(), template: imageTextTemplate("absent") }, cell: cell() }),
    );
    expect(off.status).toBe(200);
    expect(on.status).toBe(200);
    expect(absent.status).toBe(200);
    const offBytes = Buffer.from(await off.arrayBuffer());
    expect(offBytes).not.toEqual(Buffer.from(await on.arrayBuffer()));
    expect(offBytes).toEqual(Buffer.from(await absent.arrayBuffer()));
  });

  test("returns 400 with errorMessage when body parsing throws a non-Error", async () => {
    const g = globalThis as Record<string, unknown>;
    const original = g.readBody;
    g.readBody = async () => {
      throw "non-error parse failure";
    };
    try {
      const res = await mount()(jsonReq({ brief: brief(), cell: cell() }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "non-error parse failure" });
    } finally {
      g.readBody = original;
    }
  });
});
