import { describe, test, expect } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import type {
  BriefTemplate,
  CompositeRequest,
  CopyTimeline,
} from "@campaignfoundry/CampaignOrchestration";
import { NodeCanvasCompositor } from "../NodeCanvasCompositor.js";

/**
 * The motion path (`drawTimeline`, used for `copy.timeline` briefs) must draw
 * the brand logo if and only if `logoApplied` reports it — the same fact the
 * delivered asset's compliance record carries. Before this fix, the motion
 * path drew the logo whenever the file merely loaded, gated only on
 * `prepared.logo` — so a timeline template with no `logo` layer could ship
 * frames containing a logo the asset record said was absent. This pins the
 * corrected invariant: drawn and reported never disagree.
 */

const background = (): Uint8Array => {
  const c = createCanvas(64, 64);
  const g = c.getContext("2d");
  g.fillStyle = "#333333";
  g.fillRect(0, 0, 64, 64);
  return c.toBuffer("image/png");
};

type TimelineRequest = CompositeRequest & {
  readonly template: BriefTemplate;
  readonly durationSec: number;
  readonly timeline: CopyTimeline;
};

const request = (template: BriefTemplate): TimelineRequest => ({
  background: background(),
  message: "Stay wild, stay hydrated",
  brandColor: "#1473E6",
  logoPath: "assets/inputs/hydra-logo.png",
  canvas: { ratio: "1:1" },
  layout: "headline-bottom",
  tone: "bold",
  template,
  durationSec: 8,
  timeline: {
    beats: [{ text: "Stay wild, stay hydrated", weight: 1 }],
    transition: "cut",
    keyBeat: 1,
  },
});

const templateWithoutLogo: BriefTemplate = {
  id: "canonical-image-text",
  version: 1,
  creativeType: "image-text",
  unit: "standard-web",
  layers: [
    { id: "image", kind: "image" },
    { id: "shade", kind: "shade" },
    { id: "accent", kind: "accent" },
    { id: "static-text", kind: "static-text" },
  ],
};

const templateWithLogo: BriefTemplate = {
  ...templateWithoutLogo,
  layers: [...templateWithoutLogo.layers, { id: "logo", kind: "logo" }],
};

/** Draw a prepared timeline creative at `t` and count drawImage invocations. */
function drawImageCallCount(
  prepared: Awaited<ReturnType<typeof NodeCanvasCompositor.prepare>>,
  t: number,
): number {
  const canvas = createCanvas(prepared.width, prepared.height);
  const ctx = canvas.getContext("2d");
  let calls = 0;
  const origDraw = ctx.drawImage.bind(ctx);
  ctx.drawImage = ((...args: Parameters<typeof ctx.drawImage>) => {
    calls += 1;
    return origDraw(...args);
  }) as typeof ctx.drawImage;
  NodeCanvasCompositor.draw(ctx, prepared, t);
  return calls;
}

describe("the motion path draws the logo iff logoApplied reports it (D7/F2)", () => {
  test("a timeline template with no logo layer draws no logo pixels, and reports logoApplied: false", async () => {
    const prepared = await NodeCanvasCompositor.prepare(
      request(templateWithoutLogo),
    );
    // The file loaded fine; the resolved layer list simply omits `logo`.
    expect(prepared.logo).toBeDefined();
    expect(prepared.logoApplied).toBe(false);

    // Only the background blit (the "image" layer) should paint at any pose —
    // no second drawImage call for a logo that the record says is absent.
    for (const t of [0, 0.5, 1]) {
      expect(drawImageCallCount(prepared, t)).toBe(1);
    }
  });

  test("a timeline template with a logo layer draws the logo, and reports logoApplied: true", async () => {
    const prepared = await NodeCanvasCompositor.prepare(
      request(templateWithLogo),
    );
    expect(prepared.logo).toBeDefined();
    expect(prepared.logoApplied).toBe(true);

    // The background blit plus the logo blit.
    for (const t of [0, 0.5, 1]) {
      expect(drawImageCallCount(prepared, t)).toBe(2);
    }
  });
});
