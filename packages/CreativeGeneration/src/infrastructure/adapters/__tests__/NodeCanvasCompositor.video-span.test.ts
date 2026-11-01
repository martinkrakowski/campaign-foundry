import { afterEach, describe, expect, test, vi } from "vitest";
import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import {
  CANONICAL_TEMPLATES,
  type BriefTemplate,
  type CompositeRequest,
  type CreativeTemplateLayer,
  type CreativeType,
  type CopyTimeline,
  type LayerKind,
} from "@campaignfoundry/CampaignOrchestration";
import { NodeCanvasCompositor } from "../NodeCanvasCompositor.js";

import { projectRoot } from "@campaignfoundry/shared";
import { fsInputs } from "./fs-inputs.js";

const background = (): Uint8Array => {
  const c = createCanvas(64, 64);
  const g = c.getContext("2d");
  g.fillStyle = "#333333";
  g.fillRect(0, 0, 64, 64);
  return c.toBuffer("image/png");
};

type TemplateRequest = CompositeRequest & {
  readonly template?: BriefTemplate;
  readonly creativeType?: CreativeType;
};

const request = (over: Partial<TemplateRequest> = {}): TemplateRequest => ({
  background: background(),
  message: "Stay wild, stay hydrated",
  brandColor: "#1473E6",
  logoPath: "assets/inputs/hydra-logo.png",
  canvas: { ratio: "1:1" },
  layout: "headline-bottom",
  tone: "bold",
  ...over,
});

/** The kinds this compositor draws. */
const DRAWABLE_KINDS = [
  "image",
  "fill",
  "video",
  "shade",
  "accent",
  "static-text",
  "animated-text",
  "logo",
] as const;

/**
 * The compositor's dispatch table, reached through the TS-private seam (the
 * same seam `NodeCanvasCompositor.layer-order.test.ts` uses).
 */
const layerTable = (): Record<(typeof DRAWABLE_KINDS)[number], (c: unknown) => void> =>
  (
    NodeCanvasCompositor as unknown as {
      layerDrawers: Record<(typeof DRAWABLE_KINDS)[number], (c: unknown) => void>;
    }
  ).layerDrawers;

/** Swap every drawer for a kind recorder; returns the recorded order. */
function recordDrawOrder(): LayerKind[] {
  const order: LayerKind[] = [];
  const table = layerTable();
  for (const kind of DRAWABLE_KINDS) {
    vi.spyOn(table, kind).mockImplementation(() => {
      order.push(kind);
    });
  }
  return order;
}

/** The canonical video template's layers, in z-order. */
const VIDEO_LAYERS = CANONICAL_TEMPLATES.video.layers;

const videoTemplate = (layers: readonly CreativeTemplateLayer[]): BriefTemplate => ({
  id: "canonical-video",
  version: 1,
  creativeType: "video",
  unit: "standard-web",
  layers,
});

const timelineReq = (
  layers: readonly CreativeTemplateLayer[],
): TemplateRequest & { durationSec: number; timeline: CopyTimeline } => ({
  ...request({ template: videoTemplate(layers) }),
  durationSec: 6,
  timeline: {
    beats: [{ text: "Stay wild, stay hydrated", weight: 1 }],
    transition: "cut",
    keyBeat: 1,
  },
});

async function drawAt(req: TemplateRequest, t: number): Promise<LayerKind[]> {
  const prepared = await NodeCanvasCompositor.prepare(req, "Inter", fsInputs(projectRoot()));
  const ctx = createCanvas(prepared.width, prepared.height).getContext("2d");
  const order = recordDrawOrder();
  NodeCanvasCompositor.draw(ctx, prepared, t);
  return order;
}

/** Swap every drawer for a layer recorder; returns the recorded layers in paint order. */
function recordDrawnLayers(): { kind: LayerKind; id: string }[] {
  const drawn: { kind: LayerKind; id: string }[] = [];
  const table = layerTable();
  for (const kind of DRAWABLE_KINDS) {
    vi.spyOn(table, kind).mockImplementation((c: unknown) => {
      const layer = (c as { layer: CreativeTemplateLayer }).layer;
      drawn.push({ kind, id: layer.id });
    });
  }
  return drawn;
}

async function drawLayersAt(
  req: TemplateRequest,
  t: number,
): Promise<{ kind: LayerKind; id: string }[]> {
  const prepared = await NodeCanvasCompositor.prepare(req, "Inter", fsInputs(projectRoot()));
  const ctx = createCanvas(prepared.width, prepared.height).getContext("2d");
  const drawn = recordDrawnLayers();
  NodeCanvasCompositor.draw(ctx, prepared, t);
  return drawn;
}

describe("the video span paint skip (VT2)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("a video layer with no span paints on every frame — the golden-preserving case", async () => {
    for (const t of [0, 0.5, 1]) {
      const timelineOrder = await drawAt(timelineReq(VIDEO_LAYERS), t);
      expect(timelineOrder).toContain("video");
      const legacyOrder = await drawAt(request({ template: videoTemplate(VIDEO_LAYERS) }), t);
      expect(legacyOrder).toContain("video");
    }
  });

  test("a video layer paints only inside its span, on both paths", async () => {
    const spanned: readonly CreativeTemplateLayer[] = [
      { id: "video", kind: "video", span: { startT: 0.25, endT: 0.75 } },
      { id: "shade", kind: "shade" },
      { id: "animated-text", kind: "animated-text" },
      { id: "logo", kind: "logo" },
    ];
    const makeReqs = [
      (layers: readonly CreativeTemplateLayer[]) => timelineReq(layers),
      (layers: readonly CreativeTemplateLayer[]) => request({ template: videoTemplate(layers) }),
    ];
    for (const makeReq of makeReqs) {
      const order0 = await drawAt(makeReq(spanned), 0);
      expect(order0).not.toContain("video");
      expect(order0).toContain("shade");
      expect(order0).toContain("logo");

      const orderHalf = await drawAt(makeReq(spanned), 0.5);
      expect(orderHalf).toContain("video");

      const orderEnd = await drawAt(makeReq(spanned), 1);
      expect(orderEnd).not.toContain("video");
    }
  });

  test("two video layers with overlapping spans paint in list order, each inside its own span", async () => {
    const twoVideo: readonly CreativeTemplateLayer[] = [
      { id: "video", kind: "video", span: { startT: 0, endT: 0.5 } },
      { id: "video-2", kind: "video", span: { startT: 0.25, endT: 1 } },
      { id: "shade", kind: "shade" },
      { id: "animated-text", kind: "animated-text" },
      { id: "logo", kind: "logo" },
    ];
    const at04 = await drawLayersAt(timelineReq(twoVideo), 0.4);
    expect(at04.filter((l) => l.kind === "video").map((l) => l.id)).toEqual(["video", "video-2"]);
    const at0 = await drawLayersAt(timelineReq(twoVideo), 0);
    expect(at0.filter((l) => l.kind === "video").map((l) => l.id)).toEqual(["video"]);
    const at09 = await drawLayersAt(timelineReq(twoVideo), 0.9);
    expect(at09.filter((l) => l.kind === "video").map((l) => l.id)).toEqual(["video-2"]);
  });

  test("two video layers with overlapping spans paint their respective pixels with no erasure or stale frames (both paths)", async () => {
    const twoVideo: readonly CreativeTemplateLayer[] = [
      { id: "video", kind: "video", span: { startT: 0, endT: 0.5 } },
      { id: "video-2", kind: "video", span: { startT: 0.25, endT: 1 } },
      { id: "shade", kind: "shade" },
      { id: "animated-text", kind: "animated-text" },
      { id: "logo", kind: "logo" },
    ];
    const makeReqs = [
      (layers: readonly CreativeTemplateLayer[]) => timelineReq(layers),
      (layers: readonly CreativeTemplateLayer[]) => request({ template: videoTemplate(layers) }),
    ];
    for (const makeReq of makeReqs) {
      const prepared = await NodeCanvasCompositor.prepare(
        makeReq(twoVideo),
        "Inter",
        fsInputs(projectRoot()),
      );
      const canvas = createCanvas(prepared.width, prepared.height);
      const ctx = canvas.getContext("2d");

      const table = layerTable();
      vi.spyOn(table, "video").mockImplementation((c: unknown) => {
        const { ctx: drawCtx, layer } = c as {
          ctx: SKRSContext2D;
          layer: CreativeTemplateLayer;
        };
        if (layer.id === "video") {
          drawCtx.fillStyle = "#111111";
          drawCtx.fillRect(0, 0, 64, 64);
        } else if (layer.id === "video-2") {
          drawCtx.fillStyle = "#222222";
          drawCtx.fillRect(0, 0, 64, 64);
        }
      });

      // Frame 1: at t = 0, first video paints (#111111). Second video's clear ran before the loop,
      // so the first video's pixel is present and not erased.
      NodeCanvasCompositor.draw(ctx, prepared, 0);
      const pixel0 = ctx.getImageData(0, 0, 1, 1).data;
      expect(pixel0[0]).toBe(17); // #111111
      expect(pixel0[3]).toBe(255);

      // Frame 2: on the SAME canvas at t = 0.75, first video is out of span and cleared before
      // the loop; second video paints (#222222). Second video's pixel is present, no stale first frame.
      NodeCanvasCompositor.draw(ctx, prepared, 0.75);
      const pixel075 = ctx.getImageData(0, 0, 1, 1).data;
      expect(pixel075[0]).toBe(34); // #222222
      expect(pixel075[3]).toBe(255);

      vi.restoreAllMocks();
    }
  });

  test("two video layers with overlapping spans: at t = 0 first video is not erased (both paths)", async () => {
    const twoVideo: readonly CreativeTemplateLayer[] = [
      { id: "video", kind: "video", span: { startT: 0, endT: 0.5 } },
      { id: "video-2", kind: "video", span: { startT: 0.25, endT: 1 } },
      { id: "shade", kind: "shade" },
      { id: "animated-text", kind: "animated-text" },
      { id: "logo", kind: "logo" },
    ];
    const makeReqs = [
      (layers: readonly CreativeTemplateLayer[]) => timelineReq(layers),
      (layers: readonly CreativeTemplateLayer[]) => request({ template: videoTemplate(layers) }),
    ];
    for (const makeReq of makeReqs) {
      const prepared = await NodeCanvasCompositor.prepare(
        makeReq(twoVideo),
        "Inter",
        fsInputs(projectRoot()),
      );
      const canvas = createCanvas(prepared.width, prepared.height);
      const ctx = canvas.getContext("2d");

      // Frame 1 at t = 0: first video paints background (#333333).
      // If video-2's clear had run after video-1, pixel would be erased to 0.
      NodeCanvasCompositor.draw(ctx, prepared, 0);
      const pixel0 = ctx.getImageData(0, 0, 1, 1).data;
      expect(pixel0[0]).toBe(51); // #333333
      expect(pixel0[3]).toBe(255);
    }
  });

  test("disabled video layers are not cleared even when excluded by span (both paths)", async () => {
    const disabledVideo: readonly CreativeTemplateLayer[] = [
      { id: "video", kind: "video", enabled: false, span: { startT: 0.5, endT: 1 } },
      { id: "shade", kind: "shade" },
      { id: "animated-text", kind: "animated-text" },
      { id: "logo", kind: "logo" },
    ];
    const makeReqs = [
      (layers: readonly CreativeTemplateLayer[]) => timelineReq(layers),
      (layers: readonly CreativeTemplateLayer[]) => request({ template: videoTemplate(layers) }),
    ];
    for (const makeReq of makeReqs) {
      const prepared = await NodeCanvasCompositor.prepare(
        makeReq(disabledVideo),
        "Inter",
        fsInputs(projectRoot()),
      );
      const canvas = createCanvas(prepared.width, prepared.height);
      const ctx = canvas.getContext("2d");

      // Pre-fill the canvas to prove disabled layer does not clear it
      ctx.fillStyle = "#444444";
      ctx.fillRect(0, 0, prepared.width, prepared.height);

      NodeCanvasCompositor.draw(ctx, prepared, 0);
      const pixel = ctx.getImageData(0, 0, 1, 1).data;
      expect(pixel[0]).toBe(68); // #444444
      expect(pixel[3]).toBe(255);
    }
  });

  test("a span-excluded video layer clears its rect so the previous frame is gone (both paths)", async () => {
    const spanned: readonly CreativeTemplateLayer[] = [
      { id: "video", kind: "video", span: { startT: 0.25, endT: 0.75 } },
      { id: "shade", kind: "shade" },
      { id: "animated-text", kind: "animated-text" },
      { id: "logo", kind: "logo" },
    ];
    const makeReqs = [
      (layers: readonly CreativeTemplateLayer[]) => timelineReq(layers),
      (layers: readonly CreativeTemplateLayer[]) => request({ template: videoTemplate(layers) }),
    ];
    for (const makeReq of makeReqs) {
      const prepared = await NodeCanvasCompositor.prepare(
        makeReq(spanned),
        "Inter",
        fsInputs(projectRoot()),
      );
      const canvas = createCanvas(prepared.width, prepared.height);
      const ctx = canvas.getContext("2d");

      // Frame 1: inside span (t = 0.5) — video layer paints the background
      NodeCanvasCompositor.draw(ctx, prepared, 0.5);
      const frame1Pixel = ctx.getImageData(0, 0, 1, 1).data;
      expect(frame1Pixel[0]).toBe(51); // #333333
      expect(frame1Pixel[3]).toBe(255);

      // Frame 2: outside span (t = 0) on the SAME canvas — video layer clears its rect
      NodeCanvasCompositor.draw(ctx, prepared, 0);
      const frame2Pixel = ctx.getImageData(0, 0, 1, 1).data;
      // Proves the old frame is gone: pixel was cleared rather than left on canvas
      expect(frame2Pixel[3]).toBe(0);
      expect(frame2Pixel[0]).toBe(0);
    }
  });

  test("an image layer with no span still paints — the skip is kind-specific", async () => {
    const imageOnly: readonly CreativeTemplateLayer[] = [
      { id: "image", kind: "image" },
      { id: "shade", kind: "shade" },
      { id: "static-text", kind: "static-text" },
      { id: "logo", kind: "logo" },
    ];
    const order = await drawAt(request({ template: videoTemplate(imageOnly) }), 0.5);
    expect(order).toContain("image");
  });
});
