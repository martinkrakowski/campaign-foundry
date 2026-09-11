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

  test("the logo layer snaps to the text block — a logo with no text layer in the template throws, never guesses", async () => {
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
      /there is no text layer in the template at all/,
    );
  });

  test("the timeline path draws the ground trio AND the logo in the resolved list's order, even when the template reorders them (C1/C5/D121)", async () => {
    // This used to pin an intermediate contract: C1 made the motion path
    // honour the template's order for the ground trio, but `logo` (and copy)
    // still drew in a fixed position after them, regardless of where the
    // template put it (§4c of the reconciliation plan). C5 is what closes
    // that gap — it fired as designed (this assertion went red the moment
    // `drawTimeline` started dispatching `logo` through the same table at its
    // list position) — and is rewritten here to assert the new contract
    // instead of being deleted, the same way C1 rewrote its own predecessor.
    // Byte-neutrality for every caller today is proven separately, by
    // NodeCanvasCompositor.motion-goldens.test.ts: every existing caller's
    // brief carries the canonical template, so this reordering is reachable
    // only through a direct adapter call like this one, or a brief whose
    // template actually differs from canonical.
    const template: BriefTemplate = {
      id: "canonical-image-text",
      version: 1,
      creativeType: "image-text",
      unit: "standard-web",
      layers: [
        { id: "accent", kind: "accent" },
        { id: "logo", kind: "logo" },
        { id: "shade", kind: "shade" },
        { id: "image", kind: "image" },
        { id: "static-text", kind: "static-text" },
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
    // The sequenced copy keeps its own beat-selection/crossfade mechanism
    // (this lane's explicit "how" boundary): the template's static-text entry
    // never reaches `LAYER_DRAWERS` on this path (drawTimeline paints it
    // through `drawBeat` instead), so it is never recorded here. `logo`,
    // reordered ahead of `shade`/`image` in the template, now reaches the
    // table at exactly that position — the ground trio and the logo appear
    // here in the template's order, not the canonical one.
    expect(order).toEqual(["accent", "logo", "shade", "image"]);
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
    // `animated-text` never reaches `LAYER_DRAWERS` on this path (its own
    // beat-selection drawer paints it); `logo` does, at its canonical list
    // position after `shade` (C5).
    expect(orderMotion).toEqual(["video", "shade", "logo"]);
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

  test("a template that reorders a sequenced layer renders in that order in the motion frames, and matches the still path (C5)", async () => {
    // The ordering table permits `logo` anywhere `above: image` — including
    // BEFORE its own text-kind layer, so `shade` paints over it. Before C5
    // the still path refused this order outright (the logo drawer required a
    // static-text layer to have already run) and the motion path ignored it
    // (logo always drew last, after copy). Neither is true any more: both
    // read the logo's anchor from a layout `prepare` resolves independent of
    // list order (`logoAnchorLayout`), so both draw it exactly where the
    // template puts it.
    const template: BriefTemplate = {
      id: "canonical-image-text",
      version: 1,
      creativeType: "image-text",
      unit: "standard-web",
      layers: [
        { id: "image", kind: "image" },
        { id: "logo", kind: "logo" }, // below the shade — the reorder C5 must honour
        { id: "shade", kind: "shade" },
        { id: "static-text", kind: "static-text" },
      ],
    };
    const req = request({ template });

    // Still path: renders without throwing (the scope correction) — a logo
    // with no static-text drawn before it in this order used to be refused.
    const preparedStill = await NodeCanvasCompositor.prepare(req);
    const ctxStill = createCanvas(preparedStill.width, preparedStill.height).getContext("2d");
    expect(() => NodeCanvasCompositor.draw(ctxStill, preparedStill, 1)).not.toThrow();
    const stillBuf = ctxStill.canvas.toBuffer("image/png");

    // Motion path, structural proof: the table sees `logo` BEFORE `shade`,
    // matching the template — not after copy, and not after the ground trio.
    const motionReq: TemplateRequest & { durationSec: number; timeline: CopyTimeline } = {
      ...req,
      durationSec: 8,
      timeline: {
        beats: [{ text: req.message, weight: 1 }],
        transition: "cut",
        keyBeat: 1,
      },
    };
    const preparedMotion = await NodeCanvasCompositor.prepare(motionReq);
    const orderCtx = createCanvas(preparedMotion.width, preparedMotion.height).getContext("2d");
    const order = recordDrawOrder();
    NodeCanvasCompositor.draw(orderCtx, preparedMotion, 1, undefined, 0.5, 1);
    expect(order).toEqual(["image", "logo", "shade"]);
    vi.restoreAllMocks();

    // Motion path, cross-path consistency: with one beat spanning the whole
    // clip and no motion kind, the frame must be byte-identical to the still.
    // (For THIS template the logo sits opposite the headline, where the
    // shade's gradient is fully transparent either way, so this alone would
    // not catch a "logo always drawn last" regression — the `order` spy
    // above is the real proof for that. The copy-reorder test below is where
    // pixels are the ONLY proof, because copy never reaches `LAYER_DRAWERS`
    // on the motion path for the spy to see.)
    const ctxMotion = createCanvas(preparedMotion.width, preparedMotion.height).getContext("2d");
    NodeCanvasCompositor.draw(ctxMotion, preparedMotion, 1, undefined, 0.5, 1);
    const motionBuf = ctxMotion.canvas.toBuffer("image/png");
    expect(Buffer.from(motionBuf)).toEqual(Buffer.from(stillBuf));
  });

  test("a template that reorders copy relative to shade/accent renders in that order in the motion frames too (C5)", async () => {
    // Copy never reaches `LAYER_DRAWERS` on the motion path (drawSequencedCopy
    // paints it directly at its list position, not through the table), so no
    // spy can see where it drew — pixels are the only available proof here.
    // Putting `static-text` BELOW `shade`/`accent` makes the reorder
    // pixel-discriminating: the shade darkens (and the accent tints) the
    // headline-bottom region where the text sits, so "copy drawn before the
    // tint" and "copy drawn after it" are visibly, byte-wise different.
    const reordered: BriefTemplate = {
      id: "canonical-image-text",
      version: 1,
      creativeType: "image-text",
      unit: "standard-web",
      layers: [
        { id: "image", kind: "image" },
        { id: "static-text", kind: "static-text" }, // under the tint — the reorder C5 must honour
        { id: "shade", kind: "shade" },
        { id: "accent", kind: "accent" },
        { id: "logo", kind: "logo" },
      ],
    };
    const reqReordered = request({ template: reordered });
    const reqCanonical = request(); // no template — falls back to the canonical order

    const timelineFields = (message: string) => ({
      durationSec: 8,
      timeline: {
        beats: [{ text: message, weight: 1 }],
        transition: "cut" as const,
        keyBeat: 1,
      },
    });

    // Still path: renders without throwing, copy tinted by the shade/accent
    // drawn after it.
    const preparedStill = await NodeCanvasCompositor.prepare(reqReordered);
    const ctxStill = createCanvas(preparedStill.width, preparedStill.height).getContext("2d");
    NodeCanvasCompositor.draw(ctxStill, preparedStill, 1);
    const stillBuf = ctxStill.canvas.toBuffer("image/png");

    // Motion path, reordered: must match the still exactly — same reorder,
    // same tint over the copy, on both paths.
    const preparedMotionReordered = await NodeCanvasCompositor.prepare({
      ...reqReordered,
      ...timelineFields(reqReordered.message),
    });
    const ctxMotionReordered = createCanvas(
      preparedMotionReordered.width,
      preparedMotionReordered.height,
    ).getContext("2d");
    NodeCanvasCompositor.draw(ctxMotionReordered, preparedMotionReordered, 1, undefined, 0.5, 1);
    const motionReorderedBuf = ctxMotionReordered.canvas.toBuffer("image/png");
    expect(Buffer.from(motionReorderedBuf)).toEqual(Buffer.from(stillBuf));

    // Non-vacuousness: the reordered motion frame must differ from the
    // canonical-order motion frame (same message, same everything else) — if
    // it didn't, the reorder wouldn't actually be reaching the pixels, and
    // the byte match above would prove nothing.
    const preparedMotionCanonical = await NodeCanvasCompositor.prepare({
      ...reqCanonical,
      ...timelineFields(reqCanonical.message),
    });
    const ctxMotionCanonical = createCanvas(
      preparedMotionCanonical.width,
      preparedMotionCanonical.height,
    ).getContext("2d");
    NodeCanvasCompositor.draw(ctxMotionCanonical, preparedMotionCanonical, 1, undefined, 0.5, 1);
    const motionCanonicalBuf = ctxMotionCanonical.canvas.toBuffer("image/png");
    expect(Buffer.from(motionReorderedBuf)).not.toEqual(Buffer.from(motionCanonicalBuf));
  });

  test("the timeline path draws sequenced copy at most once, even when the template lists two text-kind layers (defensive)", async () => {
    // `video`'s CREATIVE_TYPE_RULES caps `animated-text` via shared budget,
    // but if an unvalidated template reaches the compositor directly,
    // the guard in `drawTimeline`'s loop is what keeps a second text-kind
    // entry from drawing the beat a second time.
    const timeline: CopyTimeline = {
      beats: [{ text: "Stay wild, stay hydrated", weight: 1 }],
      transition: "cut",
      keyBeat: 1,
    };
    const onceTemplate: BriefTemplate = {
      id: "canonical-video",
      version: 1,
      creativeType: "video",
      unit: "standard-web",
      layers: [
        { id: "video", kind: "video" },
        { id: "text-a", kind: "animated-text" },
      ],
    };
    const twiceTemplate: BriefTemplate = {
      ...onceTemplate,
      layers: [...onceTemplate.layers, { id: "text-b", kind: "animated-text" }],
    };

    const draw = async (template: BriefTemplate): Promise<number> => {
      const req: TemplateRequest & { durationSec: number; timeline: CopyTimeline } = {
        ...request({ template }),
        durationSec: 8,
        timeline,
      };
      const prepared = await NodeCanvasCompositor.prepare(req);
      const ctx = createCanvas(prepared.width, prepared.height).getContext("2d");
      const fillText = vi.spyOn(ctx, "fillText");
      NodeCanvasCompositor.draw(ctx, prepared, 1, undefined, 0.5, 1);
      return fillText.mock.calls.length;
    };

    const onePassCallCount = await draw(onceTemplate);
    expect(onePassCallCount).toBeGreaterThan(0);
    // Without the guard, a second text-kind entry would draw the beat again —
    // doubling the fillText calls. With it, the count matches the one-entry
    // baseline exactly.
    expect(await draw(twiceTemplate)).toBe(onePassCallCount);
  });

  test("the still path draws copy at most once, even when the template lists two text-kind layers (defensive)", async () => {
    const onceTemplate: BriefTemplate = {
      id: "canonical-video",
      version: 1,
      creativeType: "video",
      unit: "standard-web",
      layers: [
        { id: "video", kind: "video" },
        { id: "text-a", kind: "animated-text" },
      ],
    };
    const twiceTemplate: BriefTemplate = {
      ...onceTemplate,
      layers: [...onceTemplate.layers, { id: "text-b", kind: "animated-text" }],
    };

    const draw = async (template: BriefTemplate): Promise<number> => {
      const req = request({ template });
      const prepared = await NodeCanvasCompositor.prepare(req);
      const ctx = createCanvas(prepared.width, prepared.height).getContext("2d");
      const fillText = vi.spyOn(ctx, "fillText");
      NodeCanvasCompositor.draw(ctx, prepared, 1);
      return fillText.mock.calls.length;
    };

    const onePassCallCount = await draw(onceTemplate);
    expect(onePassCallCount).toBeGreaterThan(0);
    // Without the guard in drawLegacy, a second text-kind entry would draw the
    // copy again — doubling the fillText calls. With it, the count matches
    // the one-entry baseline exactly.
    expect(await draw(twiceTemplate)).toBe(onePassCallCount);
  });
});
