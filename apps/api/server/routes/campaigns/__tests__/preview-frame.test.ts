import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createRouter, toWebHandler, type EventHandler } from "h3";
import {
  AssetReusingImageGenerator,
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
  products: [
    { id: "alpha", name: "A", primaryColor, logoPath: "assets/inputs/alpha-logo.png" },
  ],
});

const cell = (over: Record<string, unknown> = {}) => ({
  productId: "alpha",
  ratio: "9:16",
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
    for (const chainLink of [AssetReusingImageGenerator, GeminiImageGenerator, OpenRouterImageGenerator, FireflyImageGenerator]) {
      expect(previewBackgroundGenerator).not.toBeInstanceOf(chainLink);
    }
    expect(previewCompositor).toBeInstanceOf(NodeCanvasCompositor);
  });

  test.each([
    ["a non-object brief", { brief: 42, cell: cell() }, /must be an object/],
    ["a brief missing a required field", { brief: { id: "camp" }, cell: cell() }, /missing required field/],
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
    ["a cell without a productId", { brief: brief(), cell: cell({ productId: undefined }) }, /productId/],
    ["an unknown ratio", { brief: brief(), cell: cell({ ratio: "4:3" }) }, /ratio must be one of/],
    ["an unknown layout", { brief: brief(), cell: cell({ layout: "headline-left" }) }, /layout must be one of/],
    ["an unknown tone", { brief: brief(), cell: cell({ tone: "loud" }) }, /tone must be one of/],
    ["an unknown anchor", { brief: brief(), cell: cell({ anchor: "left" }) }, /anchor must be one of/],
    ["a non-string anchor", { brief: brief(), cell: cell({ anchor: 3 }) }, /anchor must be one of/],
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
