import { afterEach, describe, expect, test, vi } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import {
  CANONICAL_TEMPLATES,
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

/** The five kinds this compositor draws, in canonical order. */
const DRAWABLE_KINDS = ["image", "shade", "accent", "static-text", "logo"] as const;

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

  test("the timeline path draws the ground trio in the fixed image → shade → accent order even when the template reorders them (D10)", async () => {
    // The motion path calls the trio by kind instead of iterating the resolved
    // list — deliberate under D10 (motion bytes are frozen; iterating a list
    // there risks them). A template's declared order governs the STILL path
    // only. This pins the current behaviour so a future list-driven change is
    // a red test rather than a silent motion diff.
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
    expect(order).toEqual(["image", "shade", "accent"]);
  });
});
