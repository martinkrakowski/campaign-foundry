import { afterEach, describe, expect, test, vi } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import {
  CANONICAL_TEMPLATES,
  templateFromCanonical,
  type BriefTemplate,
  type CompositeRequest,
  type CreativeType,
  type CopyTimeline,
  type LayerKind,
} from "@campaignfoundry/CampaignOrchestration";
import { NodeCanvasCompositor } from "../NodeCanvasCompositor.js";

/**
 * Structural tests for the layer-list dispatch (L2a, D121/D128): the draw
 * order is the template's layer list, array position is z-order. The
 * assertion surface is the dispatch table — every drawer is swapped for a
 * kind recorder, never canvas output.
 */

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
  "video",
  "shade",
  "accent",
  "static-text",
  "animated-text",
  "logo",
] as const;

/**
 * The compositor's dispatch table, reached through the TS-private seam: the
 * `@generated` barrel `export *`s the compositor file, so exporting the table
 * (or its draw-context type) would leak `SKRSContext2D` from the package
 * surface — the tests spy it through the index-signature escape instead.
 */
const layerTable = (): Record<
  (typeof DRAWABLE_KINDS)[number],
  (c: unknown) => void
> =>
  (NodeCanvasCompositor as unknown as {
    layerDrawers: Record<(typeof DRAWABLE_KINDS)[number], (c: unknown) => void>;
  }).layerDrawers;

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

async function drawWithRecorder(req: TemplateRequest): Promise<LayerKind[]> {
  const prepared = await NodeCanvasCompositor.prepare(req);
  const ctx = createCanvas(prepared.width, prepared.height).getContext("2d");
  const order = recordDrawOrder();
  NodeCanvasCompositor.draw(ctx, prepared, 1);
  return order;
}

describe("the compositor's draw order is the template's layer list (L2a, D121)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("without a template the resolved draw order is the image-text canonical list", async () => {
    const prepared = await NodeCanvasCompositor.prepare(request());
    expect(prepared.layers).toEqual(CANONICAL_TEMPLATES["image-text"].layers);
  });

  test("a creativeType without a template resolves that type's canonical layers", async () => {
    const prepared = await NodeCanvasCompositor.prepare(request({ creativeType: "video" }));
    expect(prepared.layers).toEqual(CANONICAL_TEMPLATES["video"].layers);
  });

  test("draw invokes the drawers in exactly the canonical five-layer order (D128)", async () => {
    const order = await drawWithRecorder(request());
    expect(order).toEqual(["image", "shade", "accent", "static-text", "logo"]);
  });

  test("a request carrying an explicit template draws that template's order, not the canonical default", async () => {
    const template: BriefTemplate = {
      id: "canonical-image-text",
      version: 1,
      creativeType: "image-text",
      unit: "standard-web",
      // shade and accent swapped against the canonical order: the compositor
      // must follow the brief's list, not the library default.
      layers: [
        { id: "image", kind: "image" },
        { id: "accent", kind: "accent" },
        { id: "shade", kind: "shade" },
        { id: "static-text", kind: "static-text" },
        { id: "logo", kind: "logo" },
      ],
    };
    const order = await drawWithRecorder(request({ template }));
    expect(order).toEqual(["image", "accent", "shade", "static-text", "logo"]);
  });

  test("a layer kind this compositor cannot draw throws the named error (fill)", async () => {
    const template: BriefTemplate = {
      id: "canonical-image-text",
      version: 1,
      creativeType: "image-text",
      unit: "standard-web",
      layers: [
        { id: "image", kind: "image" },
        { id: "wash", kind: "fill" },
      ],
    };
    const prepared = await NodeCanvasCompositor.prepare(request({ template }));
    const ctx = createCanvas(prepared.width, prepared.height).getContext("2d");
    expect(() => NodeCanvasCompositor.draw(ctx, prepared, 1)).toThrow(
      /layer kind "fill" has no drawer/,
    );
  });

  test("a layer kind this compositor cannot draw throws the named error (html)", async () => {
    const template: BriefTemplate = {
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
    const prepared = await NodeCanvasCompositor.prepare(request({ template }));
    const ctx = createCanvas(prepared.width, prepared.height).getContext("2d");
    expect(() => NodeCanvasCompositor.draw(ctx, prepared, 1)).toThrow(
      /layer kind "html" has no drawer/,
    );
  });

  test("the logo layer snaps to the text block — a logo with no static-text before it throws, never guesses", async () => {
    const template: BriefTemplate = {
      id: "canonical-image-text",
      version: 1,
      creativeType: "image-text",
      unit: "standard-web",
      layers: [
        { id: "image", kind: "image" },
        { id: "logo", kind: "logo" },
      ],
    };
    const prepared = await NodeCanvasCompositor.prepare(request({ template }));
    const ctx = createCanvas(prepared.width, prepared.height).getContext("2d");
    expect(() => NodeCanvasCompositor.draw(ctx, prepared, 1)).toThrow(
      /no static-text layer ran before it/,
    );
  });

  test("the timeline path draws the ground trio in the resolved list's order, even when the template reorders them (C1/D121)", async () => {
    // This used to pin the OLD behaviour deliberately — the motion path called
    // the trio by kind, ignoring the template, so that a future list-driven
    // change would be a red test instead of a silent motion diff (D10). C1 is
    // that future: it fired as designed (this assertion went red the moment
    // drawTimeline started iterating `prepared.layers`), and is rewritten here
    // to assert the new contract instead of being deleted — a lane that
    // deletes its own tripwire is indistinguishable from one that broke it.
    // Byte-neutrality for every caller today is proven separately, by
    // NodeCanvasCompositor.motion-goldens.test.ts: every existing caller's
    // brief carries the canonical template (C3 wired the port, it did not
    // change what any brief holds), so the resolved list is still the
    // canonical trio order for them and this reordering is reachable only
    // through a direct adapter call like this one, or a brief whose template
    // actually differs from canonical.
    const template: BriefTemplate = {
      id: "canonical-image-text",
      version: 1,
      creativeType: "image-text",
      unit: "standard-web",
      layers: [
        { id: "accent", kind: "accent" },
        { id: "shade", kind: "shade" },
        { id: "image", kind: "image" },
        { id: "static-text", kind: "static-text" },
        { id: "logo", kind: "logo" },
      ],
    };
    const req: TemplateRequest & { durationSec: number; timeline: CopyTimeline } = {
      ...request({ template }),
      durationSec: 8,
      timeline: {
        beats: [{ text: "Stay wild, stay hydrated", weight: 1 }],
        transition: "cut",
        keyBeat: 1,
      },
    };
    const prepared = await NodeCanvasCompositor.prepare(req);
    const ctx = createCanvas(prepared.width, prepared.height).getContext("2d");
    const order = recordDrawOrder();
    NodeCanvasCompositor.draw(ctx, prepared, 0.5, undefined, 0.5);
    // Copy and logo keep their own sequencing (this lane's scope): the
    // template's static-text/logo entries never reach `LAYER_DRAWERS` on this
    // path (drawTimeline paints them itself, through drawBeat and its own
    // drawImage call), so only the ground trio — in the template's order —
    // is ever recorded here.
    expect(order).toEqual(["accent", "shade", "image"]);
  });

  test("the timeline path throws on a ground kind it cannot draw, the same way the still path does (html)", async () => {
    // The GROUND_KINDS asymmetry C1 flagged forward: `drawTimeline` used to
    // skip every kind but the canonical trio, silently. When a template's
    // order reaches this loop, an undrawable ground kind (e.g. html, fill)
    // throws rather than silently skipping.
    const template: BriefTemplate = {
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
    const req: TemplateRequest & { durationSec: number; timeline: CopyTimeline } = {
      ...request({ template }),
      durationSec: 8,
      timeline: {
        beats: [{ text: "Stay wild, stay hydrated", weight: 1 }],
        transition: "cut",
        keyBeat: 1,
      },
    };
    const prepared = await NodeCanvasCompositor.prepare(req);
    const ctx = createCanvas(prepared.width, prepared.height).getContext("2d");
    expect(() => NodeCanvasCompositor.draw(ctx, prepared, 0.5, undefined, 0.5)).toThrow(
      /layer kind "html" has no drawer/,
    );
  });

  test("a canonical-video template renders without throwing on the still path and in motion frames (VD)", async () => {
    const template: BriefTemplate = templateFromCanonical("short-video");
    const reqStill = request({ template });
    const preparedStill = await NodeCanvasCompositor.prepare(reqStill);
    const ctxStill = createCanvas(preparedStill.width, preparedStill.height).getContext("2d");
    expect(() => NodeCanvasCompositor.draw(ctxStill, preparedStill, 1)).not.toThrow();

    const orderStill = await drawWithRecorder(reqStill);
    expect(orderStill).toEqual(["video", "shade", "animated-text", "logo"]);

    const reqMotion: TemplateRequest & { durationSec: number; timeline: CopyTimeline } = {
      ...request({ template }),
      durationSec: 8,
      timeline: {
        beats: [{ text: "Stay wild, stay hydrated", weight: 1 }],
        transition: "cut",
        keyBeat: 1,
      },
    };
    const preparedMotion = await NodeCanvasCompositor.prepare(reqMotion);
    const ctxMotion = createCanvas(preparedMotion.width, preparedMotion.height).getContext("2d");
    expect(() => NodeCanvasCompositor.draw(ctxMotion, preparedMotion, 0.5, "ken-burns-out", 0.5)).not.toThrow();

    const orderMotion = recordDrawOrder();
    NodeCanvasCompositor.draw(ctxMotion, preparedMotion, 0.5, "ken-burns-out", 0.5);
    expect(orderMotion).toEqual(["video", "shade"]);
  });

  test("the video layer draws the exact same pixels the image layer would (VD)", async () => {
    const imageTemplate: BriefTemplate = {
      id: "canonical-image-text",
      version: 1,
      creativeType: "image-text",
      unit: "standard-web",
      layers: [{ id: "ground", kind: "image" }],
    };
    const videoTemplate: BriefTemplate = {
      id: "canonical-video",
      version: 1,
      creativeType: "video",
      unit: "standard-web",
      layers: [{ id: "ground", kind: "video" }],
    };

    const bg = background();
    const baseReq = {
      background: bg,
      message: "Stay wild, stay hydrated",
      brandColor: "#1473E6",
      logoPath: "assets/inputs/hydra-logo.png",
      canvas: { ratio: "1:1" as const },
      layout: "headline-bottom" as const,
      tone: "bold" as const,
    };

    // Still path proof
    const prepImageStill = await NodeCanvasCompositor.prepare({ ...baseReq, template: imageTemplate });
    const prepVideoStill = await NodeCanvasCompositor.prepare({ ...baseReq, template: videoTemplate });
    const canvasImageStill = createCanvas(prepImageStill.width, prepImageStill.height);
    const canvasVideoStill = createCanvas(prepVideoStill.width, prepVideoStill.height);
    NodeCanvasCompositor.draw(canvasImageStill.getContext("2d"), prepImageStill, 1);
    NodeCanvasCompositor.draw(canvasVideoStill.getContext("2d"), prepVideoStill, 1);
    const imgStillBuf = canvasImageStill.toBuffer("image/png");
    const vidStillBuf = canvasVideoStill.toBuffer("image/png");
    expect(vidStillBuf.length).toBeGreaterThan(0);
    expect(Buffer.from(vidStillBuf)).toEqual(Buffer.from(imgStillBuf));

    // Motion path proof with zoom (ken-burns-in at t=0.5 where zoom !== 1)
    const motionReq = {
      ...baseReq,
      durationSec: 8,
      timeline: {
        beats: [{ text: "Stay wild, stay hydrated", weight: 1 }],
        transition: "cut" as const,
        keyBeat: 1,
      },
    };
    const prepImageMotion = await NodeCanvasCompositor.prepare({ ...motionReq, template: imageTemplate });
    const prepVideoMotion = await NodeCanvasCompositor.prepare({ ...motionReq, template: videoTemplate });
    const canvasImageMotion = createCanvas(prepImageMotion.width, prepImageMotion.height);
    const canvasVideoMotion = createCanvas(prepVideoMotion.width, prepVideoMotion.height);
    NodeCanvasCompositor.draw(canvasImageMotion.getContext("2d"), prepImageMotion, 0.5, "ken-burns-in", 0.5);
    NodeCanvasCompositor.draw(canvasVideoMotion.getContext("2d"), prepVideoMotion, 0.5, "ken-burns-in", 0.5);
    const imgMotionBuf = canvasImageMotion.toBuffer("image/png");
    const vidMotionBuf = canvasVideoMotion.toBuffer("image/png");
    expect(vidMotionBuf.length).toBeGreaterThan(0);
    expect(Buffer.from(vidMotionBuf)).toEqual(Buffer.from(imgMotionBuf));
  });
});
