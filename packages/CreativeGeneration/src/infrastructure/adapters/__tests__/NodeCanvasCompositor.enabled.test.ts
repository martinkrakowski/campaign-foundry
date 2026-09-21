import { afterEach, describe, expect, test, vi } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import {
  type BriefTemplate,
  type CompositeRequest,
  type CopyTimeline,
  type CreativeTemplateLayer,
  type CreativeType,
} from "@campaignfoundry/CampaignOrchestration";
import { NodeCanvasCompositor } from "../NodeCanvasCompositor.js";

/**
 * X9: a layer the brief disabled must not be drawn. `enabled` is a validated
 * field on every layer (D129) and absence means enabled, so the acceptance at
 * both boundaries reads as a promise the renderer used never to make — the
 * layer rendered anyway.
 *
 * The assertion surface is pixels, not the dispatch spy: a skipped layer is
 * exactly an absent one, so "disabled renders the frame of the template
 * without that layer" is the strongest true statement available, and it holds
 * for every kind at once. Where a kind's draw is invisible to the table (the
 * sequenced copy on the motion path) pixels are the only proof there is.
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
  readonly durationSec?: number;
  readonly timeline?: CopyTimeline;
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

const templateWith = (layers: readonly CreativeTemplateLayer[]): BriefTemplate => ({
  id: "canonical-image-text",
  version: 1,
  creativeType: "image-text",
  unit: "standard-web",
  layers,
});

/** One beat spanning the whole clip, no motion kind: the motion path's rest frame. */
const timelineRequest = (template: BriefTemplate, message: string): TemplateRequest =>
  request({
    template,
    durationSec: 8,
    timeline: {
      beats: [{ text: message, weight: 1 }],
      transition: "cut",
      keyBeat: 1,
    },
  });

/** The still path's frame. */
async function renderStill(req: TemplateRequest): Promise<Buffer> {
  const prepared = await NodeCanvasCompositor.prepare(req);
  const ctx = createCanvas(prepared.width, prepared.height).getContext("2d");
  NodeCanvasCompositor.draw(ctx, prepared, 1);
  return ctx.canvas.toBuffer("image/png");
}

/** The sequenced path's frame at the copy's mid-time, effect settled. */
async function renderTimeline(req: TemplateRequest): Promise<Buffer> {
  const prepared = await NodeCanvasCompositor.prepare(req);
  const ctx = createCanvas(prepared.width, prepared.height).getContext("2d");
  NodeCanvasCompositor.draw(ctx, prepared, 1, undefined, 0.5, 1);
  return ctx.canvas.toBuffer("image/png");
}

/** How many text blits a still frame makes. */
async function fillTextCalls(req: TemplateRequest): Promise<number> {
  const prepared = await NodeCanvasCompositor.prepare(req);
  const ctx = createCanvas(prepared.width, prepared.height).getContext("2d");
  const spy = vi.spyOn(ctx, "fillText");
  NodeCanvasCompositor.draw(ctx, prepared, 1);
  return spy.mock.calls.length;
}

const COPY = { id: "copy", kind: "static-text" } as const;

describe("the compositor does not draw a disabled layer (X9, D129)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("still: a disabled layer renders the frame of the template without that layer", async () => {
    const enabled = await renderStill(
      request({
        template: templateWith([
          { id: "image", kind: "image" },
          { id: "shade", kind: "shade" },
          COPY,
        ]),
      }),
    );
    const absent = await renderStill(
      request({ template: templateWith([{ id: "image", kind: "image" }, COPY]) }),
    );
    const disabled = await renderStill(
      request({
        template: templateWith([
          { id: "image", kind: "image" },
          { id: "shade", kind: "shade", enabled: false },
          COPY,
        ]),
      }),
    );
    // Non-vacuousness: the shade really is visible when it draws, so "disabled
    // equals absent" is not two identical renders of nothing.
    expect(Buffer.from(enabled)).not.toEqual(Buffer.from(absent));
    expect(Buffer.from(disabled)).toEqual(Buffer.from(absent));
  });

  test("still: absence means enabled — a layer with no `enabled` key paints what `enabled: true` paints", async () => {
    const explicit = await renderStill(
      request({
        template: templateWith([
          { id: "image", kind: "image", enabled: true },
          { id: "shade", kind: "shade", enabled: true },
          { id: "accent", kind: "accent", enabled: true },
          { id: "copy", kind: "static-text", enabled: true },
          { id: "logo", kind: "logo", enabled: true },
        ]),
      }),
    );
    const implied = await renderStill(
      request({
        template: templateWith([
          { id: "image", kind: "image" },
          { id: "shade", kind: "shade" },
          { id: "accent", kind: "accent" },
          { id: "copy", kind: "static-text" },
          { id: "logo", kind: "logo" },
        ]),
      }),
    );
    expect(Buffer.from(implied)).toEqual(Buffer.from(explicit));
    expect(await fillTextCalls(request({ template: templateWith([COPY]) }))).toBeGreaterThan(0);
  });

  test("still: a disabled copy layer paints no text at all", async () => {
    expect(
      await fillTextCalls(
        request({
          template: templateWith([
            { id: "image", kind: "image" },
            { id: "copy", kind: "static-text", enabled: false },
          ]),
        }),
      ),
    ).toBe(0);
  });

  test("still: a disabled copy layer does not consume the copy budget — the enabled copy after it paints", async () => {
    // The ordering this lane has to get right: `copyDrawn` is the D124 text-kind
    // guard, and a disabled copy layer that SETS it silently drops the enabled
    // copy that follows — the same accepted-then-not-rendered promise, one layer
    // later. So the skip must run before the guard, and this template's copy is
    // only on screen if it drew after the shade.
    const copyBeforeShade = await renderStill(
      request({
        template: templateWith([
          { id: "image", kind: "image" },
          COPY,
          { id: "shade", kind: "shade" },
        ]),
      }),
    );
    const copyAfterShade = await renderStill(
      request({
        template: templateWith([
          { id: "image", kind: "image" },
          { id: "shade", kind: "shade" },
          COPY,
        ]),
      }),
    );
    // Non-vacuousness: where the copy sits relative to the shade is visible, so
    // matching `copyAfterShade` below proves WHICH layer drew the copy.
    expect(Buffer.from(copyBeforeShade)).not.toEqual(Buffer.from(copyAfterShade));

    const disabledThenEnabled = await renderStill(
      request({
        template: templateWith([
          { id: "image", kind: "image" },
          { id: "copy-off", kind: "static-text", enabled: false },
          { id: "shade", kind: "shade" },
          { id: "copy-on", kind: "static-text" },
        ]),
      }),
    );
    expect(Buffer.from(disabledThenEnabled)).toEqual(Buffer.from(copyAfterShade));
  });

  test("timeline: a disabled layer renders the frame of the template without that layer", async () => {
    const enabled = await renderTimeline(
      timelineRequest(
        templateWith([{ id: "image", kind: "image" }, { id: "shade", kind: "shade" }, COPY]),
        "Stay wild, stay hydrated",
      ),
    );
    const absent = await renderTimeline(
      timelineRequest(
        templateWith([{ id: "image", kind: "image" }, COPY]),
        "Stay wild, stay hydrated",
      ),
    );
    const disabled = await renderTimeline(
      timelineRequest(
        templateWith([
          { id: "image", kind: "image" },
          { id: "shade", kind: "shade", enabled: false },
          COPY,
        ]),
        "Stay wild, stay hydrated",
      ),
    );
    expect(Buffer.from(enabled)).not.toEqual(Buffer.from(absent));
    expect(Buffer.from(disabled)).toEqual(Buffer.from(absent));
  });

  test("timeline: a disabled copy layer does not consume the copy budget — the enabled copy after it paints", async () => {
    const copyBeforeShade = await renderTimeline(
      timelineRequest(
        templateWith([{ id: "image", kind: "image" }, COPY, { id: "shade", kind: "shade" }]),
        "Stay wild, stay hydrated",
      ),
    );
    const copyAfterShade = await renderTimeline(
      timelineRequest(
        templateWith([{ id: "image", kind: "image" }, { id: "shade", kind: "shade" }, COPY]),
        "Stay wild, stay hydrated",
      ),
    );
    expect(Buffer.from(copyBeforeShade)).not.toEqual(Buffer.from(copyAfterShade));

    const disabledThenEnabled = await renderTimeline(
      timelineRequest(
        templateWith([
          { id: "image", kind: "image" },
          { id: "copy-off", kind: "animated-text", enabled: false },
          { id: "shade", kind: "shade" },
          { id: "copy-on", kind: "static-text" },
        ]),
        "Stay wild, stay hydrated",
      ),
    );
    expect(Buffer.from(disabledThenEnabled)).toEqual(Buffer.from(copyAfterShade));
  });

  test("a disabled fill is an ordinary hide now that the kind is drawable (L11)", async () => {
    // These two tests used to assert that a disabled `fill` STILL threw: the
    // renderer could not draw the kind switched on either, so letting the
    // `enabled: false` skip swallow it would have turned L6's refusal into an
    // accepted-then-not-rendered promise. L11 draws `fill` (D131), so there is
    // no refusal left to protect and the rule that applies is D129's: a
    // disabled layer renders exactly what the same template without it renders.
    const off = templateWith([
      { id: "image", kind: "image" },
      { id: "wash", kind: "fill", enabled: false },
    ]);
    const absent = templateWith([{ id: "image", kind: "image" }]);
    const withOff = await NodeCanvasCompositor.prepare(request({ template: off }));
    const withAbsent = await NodeCanvasCompositor.prepare(request({ template: absent }));
    const drawOne = (prepared: Awaited<ReturnType<typeof NodeCanvasCompositor.prepare>>) => {
      const canvas = createCanvas(prepared.width, prepared.height);
      NodeCanvasCompositor.draw(canvas.getContext("2d"), prepared, 1);
      return canvas.toBuffer("image/png");
    };
    expect(Buffer.from(drawOne(withOff))).toEqual(Buffer.from(drawOne(withAbsent)));
  });

  test("a disabled fill is skipped on the sequenced path too (L11)", async () => {
    const off = timelineRequest(
      templateWith([
        { id: "image", kind: "image" },
        { id: "wash", kind: "fill", enabled: false },
      ]),
      "Stay wild, stay hydrated",
    );
    const absent = timelineRequest(
      templateWith([{ id: "image", kind: "image" }]),
      "Stay wild, stay hydrated",
    );
    const drawOne = async (req: Parameters<typeof NodeCanvasCompositor.prepare>[0]) => {
      const prepared = await NodeCanvasCompositor.prepare(req);
      const canvas = createCanvas(prepared.width, prepared.height);
      NodeCanvasCompositor.draw(canvas.getContext("2d"), prepared, 1, undefined, 0.5, 1);
      return canvas.toBuffer("image/png");
    };
    expect(Buffer.from(await drawOne(off))).toEqual(Buffer.from(await drawOne(absent)));
  });

  test("logoApplied reports what was drawn: a disabled logo layer applies no logo", async () => {
    const compositor = new NodeCanvasCompositor();
    const disabled = await compositor.compositeAsset(
      request({
        template: templateWith([
          { id: "image", kind: "image" },
          COPY,
          { id: "logo", kind: "logo", enabled: false },
        ]),
      }),
    );
    expect(disabled.logoApplied).toBe(false);
    const absent = await compositor.compositeAsset(
      request({ template: templateWith([{ id: "image", kind: "image" }, COPY]) }),
    );
    expect(absent.logoApplied).toBe(false);
    expect(Buffer.from(disabled.image)).toEqual(Buffer.from(absent.image));
    const enabled = await compositor.compositeAsset(
      request({
        template: templateWith([
          { id: "image", kind: "image" },
          COPY,
          { id: "logo", kind: "logo" },
        ]),
      }),
    );
    expect(enabled.logoApplied).toBe(true);
    expect(Buffer.from(enabled.image)).not.toEqual(Buffer.from(absent.image));
  });
});
