import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createRouter, toWebHandler, type EventHandler } from "h3";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { HtmlElement } from "@campaignfoundry/CampaignOrchestration";
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
  products: [
    { id: "alpha", name: "A", primaryColor, logoPath: "assets/inputs/alpha-logo.png" },
  ],
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
    const res = await mount()(jsonReq({ brief: brief(), cell: cell({ canvas: { size: "728x90" } }) }));
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
    for (const chainLink of [AssetReusingImageGenerator, GeminiImageGenerator, OpenRouterImageGenerator, FireflyImageGenerator]) {
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
    ["a non-object canvas", { brief: brief(), cell: cell({ canvas: "728x90" }) }, /canvas/],
    ["a canvas carrying both families", { brief: brief(), cell: cell({ canvas: { ratio: "9:16", size: "728x90" } }) }, /exactly one of ratio\/size/],
    ["a canvas carrying neither family", { brief: brief(), cell: cell({ canvas: {} }) }, /exactly one of ratio\/size/],
    ["an unknown ratio", { brief: brief(), cell: cell({ canvas: { ratio: "4:3" } }) }, /canvas ratio must be one of/],
    ["an unknown display size", { brief: brief(), cell: cell({ canvas: { size: "banner" } }) }, /canvas size must be one of/],
    ["an unknown layout", { brief: brief(), cell: cell({ layout: "headline-left" }) }, /layout must be one of/],
    ["an unknown tone", { brief: brief(), cell: cell({ tone: "loud" }) }, /tone must be one of/],
    ["an unknown anchor", { brief: brief(), cell: cell({ anchor: "left" }) }, /anchor must be one of/],
    ["a non-string anchor", { brief: brief(), cell: cell({ anchor: 3 }) }, /anchor must be one of/],
    ["motion without durationSec and atSec", { brief: brief(), cell: cell({ motion: "ken-burns-in" }) }, /motion, durationSec and atSec together/],
    ["durationSec without motion and atSec", { brief: brief(), cell: cell({ durationSec: 6 }) }, /motion, durationSec and atSec together/],
    ["atSec without motion and durationSec", { brief: brief(), cell: cell({ atSec: 2 }) }, /motion, durationSec and atSec together/],
    ["an unknown motion kind", { brief: brief(), cell: cell({ motion: "spin", durationSec: 6, atSec: 2 }) }, /motion must be one of/],
    ["durationSec out of range", { brief: brief(), cell: cell({ motion: "ken-burns-in", durationSec: 35, atSec: 2 }) }, /durationSec/],
    ["atSec out of range", { brief: brief(), cell: cell({ motion: "ken-burns-in", durationSec: 6, atSec: 8 }) }, /atSec/],
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

  /**
   * HL5d — the editor preview draws the `html` layer.
 *
 * The preview is the only place a user sees an element they just added (HL-D7:
 * no user-authored string is rendered into the operator's own DOM), so these
 * tests ask the route for the SAME cell twice — once carrying an element, once
 * carrying none — and compare the bytes the real compositor drew. Pixel
 * identity outside the element's own frame is what makes "drawn" more than
 * "accepted": a preview that silently dropped the layer would answer 200
 * `image/png` for both and differ nowhere.
 */
describe("the html layer (HL5d)", () => {
  /**
   * The canonical `image-html` template, materialised: image, html, logo. No
   * campaign type seeds it — D120's presets name three social types — so the
   * pinned id is the library's own, spelled out rather than derived.
   */
  const htmlTemplate = (
    html: Record<string, unknown> = {},
    extra: readonly Record<string, unknown>[] = [],
  ) => ({
    id: "canonical-image-html",
    version: 1,
    creativeType: "image-html",
    unit: "standard-web",
    layers: [
      { id: "image", kind: "image" },
      { id: "html", kind: "html", ...html },
      ...extra,
      { id: "logo", kind: "logo" },
    ],
  });

  /** A frame well inside a 9:16 canvas, so "outside it" is most of the image. */
  const FRAME = { x: 0.1, y: 0.42, w: 0.8, h: 0.12, anchor: "middle" } as const;

  const textElement = (text: string): HtmlElement => ({ kind: "text", text, frame: FRAME });

  const htmlBrief = (
    html: Record<string, unknown> = {},
    extra: readonly Record<string, unknown>[] = [],
  ) => ({
    ...brief(),
    template: htmlTemplate(html, extra),
    // The family an `image-html` template actually produces (D119, X14): the
    // boundary refuses one left on the static default, preview included.
    output: { formats: ["html"] },
  });

  /** One frame's decoded pixels, as the compositor's own tests decode them. */
  interface Frame {
    readonly data: Uint8ClampedArray;
    readonly width: number;
    readonly height: number;
  }

  const decode = async (png: Uint8Array): Promise<Frame> => {
    const image = await loadImage(Buffer.from(png));
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    return { data: ctx.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width, height: canvas.height };
  };

  /** One rendered preview frame: its cache key and its decoded pixels. */
  const render = async (body: { brief: unknown; cell: unknown }) => {
    const res = await mount()(jsonReq(body));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    return {
      key: res.headers.get("x-preview-frame-cache-key")!,
      frame: await decode(Buffer.from(await res.arrayBuffer())),
    };
  };

  /**
   * How many pixels differ between two frames of one canvas, split by the
   * element's own frame (X10 clips the drawer to it, so a drawn element cannot
   * move a pixel outside).
   */
  const diffByRegion = (a: Frame, b: Frame): { inside: number; outside: number } => {
    expect(a.width).toBe(b.width);
    expect(a.height).toBe(b.height);
    const x0 = Math.round(FRAME.x * a.width);
    const x1 = Math.round((FRAME.x + FRAME.w) * a.width);
    const y0 = Math.round(FRAME.y * a.height);
    const y1 = Math.round((FRAME.y + FRAME.h) * a.height);
    let inside = 0;
    let outside = 0;
    for (let y = 0; y < a.height; y += 1) {
      const rowInBox = y >= y0 && y < y1;
      for (let x = 0; x < a.width; x += 1) {
        const i = (y * a.width + x) * 4;
        if (
          a.data[i] === b.data[i] &&
          a.data[i + 1] === b.data[i + 1] &&
          a.data[i + 2] === b.data[i + 2] &&
          a.data[i + 3] === b.data[i + 3]
        ) {
          continue;
        }
        if (rowInBox && x >= x0 && x < x1) inside += 1;
        else outside += 1;
      }
    }
    return { inside, outside };
  };

  test("an element draws inside its own frame and nowhere else", async () => {
    const withElement = await render({
      brief: htmlBrief({ elements: [textElement("Summer Sale")] }),
      cell: cell(),
    });
    const without = await render({ brief: htmlBrief(), cell: cell() });

    expect(withElement.key).toMatch(/^[a-f0-9]{64}$/);
    expect(withElement.key).not.toBe(without.key);

    const diff = diffByRegion(withElement.frame, without.frame);
    expect(diff.inside).toBeGreaterThan(0);
    expect(diff.outside).toBe(0);
  });

  test("changing only the element's copy moves the key and the pixels inside the frame", async () => {
    const first = await render({
      brief: htmlBrief({ elements: [textElement("Summer Sale")] }),
      cell: cell(),
    });
    const second = await render({
      brief: htmlBrief({ elements: [textElement("Winter Sale")] }),
      cell: cell(),
    });

    expect(second.key).not.toBe(first.key);
    const diff = diffByRegion(second.frame, first.frame);
    expect(diff.inside).toBeGreaterThan(0);
    // The copy stays inside its own frame (X10), so nothing outside it moves.
    expect(diff.outside).toBe(0);
  });

  test("an element whose copy is markup renders image/png — drawn as text, never parsed", async () => {
    const hostile = await render({
      brief: htmlBrief({ elements: [textElement("<img src=x onerror=alert(1)>")] }),
      cell: cell(),
    });
    expect(hostile.key).toMatch(/^[a-f0-9]{64}$/);

    // It was drawn, not dropped: the same cell without it differs inside the frame.
    const without = await render({ brief: htmlBrief(), cell: cell() });
    expect(diffByRegion(hostile.frame, without.frame).inside).toBeGreaterThan(0);
  });

  test("a disabled html layer renders pixel-identical to the same template without it", async () => {
    // The disabled layer is an ADDITION, not the canonical one: `html` is a
    // required kind for `image-html`, so MP-D4 refuses a brief whose only html
    // layer is off (load-brief.test.ts pins that refusal) — a second, enabled
    // html layer is what makes a disabled one legal. What is being pinned is
    // X9's own promise: a disabled layer renders what the template renders with
    // that layer absent.
    const disabled = await render({
      brief: htmlBrief({}, [
        { id: "html-paused", kind: "html", enabled: false, elements: [textElement("Summer Sale")] },
      ]),
      cell: cell(),
    });
    const without = await render({ brief: htmlBrief(), cell: cell() });

    const diff = diffByRegion(disabled.frame, without.frame);
    expect(diff.inside + diff.outside).toBe(0);
  });
});
});
