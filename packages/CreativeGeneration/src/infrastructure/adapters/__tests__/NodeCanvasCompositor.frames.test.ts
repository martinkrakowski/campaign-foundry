import { describe, expect, test } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import {
  type BriefTemplate,
  type CompositeRequest,
  type CopyTimeline,
  type CreativeTemplateLayer,
} from "@campaignfoundry/CampaignOrchestration";
import type { CanvasSpec } from "@campaignfoundry/CampaignOrchestration/aspect-ratios";
import type { LayerFrame } from "@campaignfoundry/CampaignOrchestration/creative-geometry";
import { NodeCanvasCompositor } from "../NodeCanvasCompositor.js";

import { projectRoot } from "@campaignfoundry/shared";
/**
 * L10a / D130: a present `layer.frame` is the draw rect (base + byFamily for
 * the current canvas family). Absent is today's geometry, byte-identical —
 * which is how canonical templates (no `frame` key) leave the goldens unedited.
 */

const RED = "#cc0000";
const RED_RGB: readonly [number, number, number] = [0xcc, 0, 0];
const BRAND = "#1473E6";
const BRAND_RGB: readonly [number, number, number] = [0x14, 0x73, 0xe6];

const redBackground = (width: number, height: number): Uint8Array => {
  const c = createCanvas(width, height);
  const g = c.getContext("2d");
  g.fillStyle = RED;
  g.fillRect(0, 0, width, height);
  return c.toBuffer("image/png");
};

type TemplateRequest = CompositeRequest & {
  readonly template?: BriefTemplate;
  readonly durationSec?: number;
  readonly timeline?: CopyTimeline;
};

const request = (
  canvas: CanvasSpec,
  width: number,
  height: number,
  layers: readonly CreativeTemplateLayer[],
): TemplateRequest => ({
  background: redBackground(width, height),
  message: "Stay wild, stay hydrated",
  brandColor: BRAND,
  logoPath: "assets/inputs/hydra-logo.png",
  canvas,
  pixelSize: { width, height },
  layout: "headline-bottom",
  tone: "bold",
  template: {
    id: "canonical-image-text",
    version: 1,
    creativeType: "image-text",
    unit: "standard-web",
    layers,
  },
});

const IMAGE_TEXT = (
  image: CreativeTemplateLayer,
  extras: Partial<
    Record<"shade" | "accent" | "static-text" | "logo", Partial<CreativeTemplateLayer>>
  > = {},
): readonly CreativeTemplateLayer[] => [
  image,
  { id: "shade", kind: "shade", enabled: false, ...extras.shade },
  { id: "accent", kind: "accent", enabled: false, ...extras.accent },
  { id: "static-text", kind: "static-text", ...extras["static-text"] },
  { id: "logo", kind: "logo", enabled: false, ...extras.logo },
];

interface FramePixels {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

async function pixels(req: TemplateRequest): Promise<FramePixels> {
  const prepared = await NodeCanvasCompositor.prepare(req, "Inter", projectRoot());
  const canvas = createCanvas(prepared.width, prepared.height);
  const ctx = canvas.getContext("2d");
  NodeCanvasCompositor.draw(ctx, prepared, 1);
  const imageData = ctx.getImageData(0, 0, prepared.width, prepared.height);
  return { data: imageData.data, width: prepared.width, height: prepared.height };
}

async function timelinePixels(req: TemplateRequest): Promise<FramePixels> {
  const prepared = await NodeCanvasCompositor.prepare(req, "Inter", projectRoot());
  const canvas = createCanvas(prepared.width, prepared.height);
  const ctx = canvas.getContext("2d");
  NodeCanvasCompositor.draw(ctx, prepared, 1, undefined, 0.5, 1);
  const imageData = ctx.getImageData(0, 0, prepared.width, prepared.height);
  return { data: imageData.data, width: prepared.width, height: prepared.height };
}

const withTimeline = (req: TemplateRequest): TemplateRequest => ({
  ...req,
  durationSec: 8,
  timeline: {
    beats: [{ text: req.message, weight: 1 }],
    transition: "cut",
    keyBeat: 1,
  },
});

const at = (f: FramePixels, x: number, y: number): readonly [number, number, number] => {
  const i = (y * f.width + x) * 4;
  return [f.data[i]!, f.data[i + 1]!, f.data[i + 2]!];
};

const isRed = (rgb: readonly [number, number, number]): boolean =>
  rgb[0] === RED_RGB[0] && rgb[1] === RED_RGB[1] && rgb[2] === RED_RGB[2];

const sameBytes = (a: FramePixels, b: FramePixels): boolean =>
  a.width === b.width && a.height === b.height && a.data.every((v, i) => v === b.data[i]);

/** Non-ground pixels strictly below `yMax` — the region a top-strip clip must clear. */
const nonRedBelow = (f: FramePixels, yMax: number): number => {
  let n = 0;
  for (let y = yMax; y < f.height; y++) {
    for (let x = 0; x < f.width; x++) {
      if (!isRed(at(f, x, y))) n += 1;
    }
  }
  return n;
};

const HALF: LayerFrame = { x: 0, y: 0, w: 1, h: 0.5, anchor: "top" };
const SIZE_OVERRIDE: LayerFrame = {
  ...HALF,
  byFamily: { size: { "300x250": { h: 0.25 } } },
};

describe("compositor layer frames (D130, L10a)", () => {
  test("a full-canvas frame on the ground is byte-identical to an absent frame", async () => {
    const absent = await pixels(
      request({ ratio: "1:1" }, 80, 80, IMAGE_TEXT({ id: "image", kind: "image" })),
    );
    const full = await pixels(
      request(
        { ratio: "1:1" },
        80,
        80,
        IMAGE_TEXT({
          id: "image",
          kind: "image",
          frame: { x: 0, y: 0, w: 1, h: 1, anchor: "top" },
        }),
      ),
    );
    expect(sameBytes(absent, full)).toBe(true);
  });

  test("a byFamily.size 300x250 override applies at 300x250 and not at 1:1 or 728x90", async () => {
    const layers = IMAGE_TEXT({ id: "image", kind: "image", frame: SIZE_OVERRIDE });

    const square = await pixels(request({ ratio: "1:1" }, 80, 80, layers));
    // Top half is the image; below it the ground did not paint.
    expect(isRed(at(square, 2, 10))).toBe(true);
    expect(isRed(at(square, 2, 30))).toBe(true);
    expect(isRed(at(square, 2, 60))).toBe(false);

    const leaderboard = await pixels(request({ size: "728x90" }, 80, 10, layers));
    expect(isRed(at(leaderboard, 2, 2))).toBe(true);
    expect(isRed(at(leaderboard, 2, 7))).toBe(false);

    const mrec = await pixels(request({ size: "300x250" }, 60, 50, layers));
    // h: 0.25 at 50px → dest ends at y=12.5. y=6 is inside; y=18 is inside
    // the base 0.5 but outside the size overlay.
    expect(isRed(at(mrec, 2, 6))).toBe(true);
    expect(isRed(at(mrec, 2, 18))).toBe(false);
    expect(isRed(at(mrec, 2, 40))).toBe(false);
  });

  test("a shade frame fills only the resolved rect", async () => {
    const layers = IMAGE_TEXT(
      { id: "image", kind: "image" },
      {
        shade: {
          enabled: true,
          frame: { x: 0, y: 0, w: 0.5, h: 1, anchor: "top" },
        },
      },
    );
    const f = await pixels(request({ ratio: "1:1" }, 40, 40, layers));
    // Left half is shaded (darker than the red ground); right half stays red.
    expect(isRed(at(f, 30, 20))).toBe(true);
    expect(isRed(at(f, 5, 20))).toBe(false);
  });

  test("an accent frame fills the resolved rect with the brand colour", async () => {
    const layers = IMAGE_TEXT(
      { id: "image", kind: "image" },
      {
        accent: {
          enabled: true,
          frame: { x: 0, y: 0, w: 1, h: 0.25, anchor: "top" },
        },
      },
    );
    const f = await pixels(request({ ratio: "1:1" }, 40, 40, layers));
    const top = at(f, 20, 4);
    expect(top[0]).toBe(BRAND_RGB[0]);
    expect(top[1]).toBe(BRAND_RGB[1]);
    expect(top[2]).toBe(BRAND_RGB[2]);
  });

  test("a logo frame draws the logo into the resolved rect", async () => {
    const layers = IMAGE_TEXT(
      { id: "image", kind: "image" },
      {
        logo: {
          enabled: true,
          frame: { x: 0, y: 0, w: 0.4, h: 0.4, anchor: "top" },
        },
      },
    );
    const withLogo = await pixels(request({ ratio: "1:1" }, 40, 40, layers));
    const without = await pixels(
      request({ ratio: "1:1" }, 40, 40, IMAGE_TEXT({ id: "image", kind: "image" })),
    );
    expect(sameBytes(withLogo, without)).toBe(false);
    // The framed logo sits in the top-left; the default top-right is empty of it.
    expect(at(withLogo, 4, 4).some((v, i) => v !== at(without, 4, 4)[i])).toBe(true);
  });

  test("a text frame clips the headline to the resolved rect", async () => {
    const clipped = await pixels(
      request(
        { ratio: "1:1" },
        80,
        80,
        IMAGE_TEXT(
          { id: "image", kind: "image" },
          { "static-text": { frame: { x: 0, y: 0, w: 1, h: 0.15, anchor: "top" } } },
        ),
      ),
    );
    const full = await pixels(
      request({ ratio: "1:1" }, 80, 80, IMAGE_TEXT({ id: "image", kind: "image" })),
    );
    // Default headline sits near the bottom; clipping to the top strip hides it.
    expect(sameBytes(clipped, full)).toBe(false);
  });

  test("a text frame clips sequenced copy on the timeline path", async () => {
    const clip = { x: 0, y: 0, w: 1, h: 0.15, anchor: "top" as const };
    const clipped = await timelinePixels(
      withTimeline(
        request(
          { ratio: "1:1" },
          80,
          80,
          IMAGE_TEXT({ id: "image", kind: "image" }, { "static-text": { frame: clip } }),
        ),
      ),
    );
    const full = await timelinePixels(
      withTimeline(request({ ratio: "1:1" }, 80, 80, IMAGE_TEXT({ id: "image", kind: "image" }))),
    );
    expect(sameBytes(clipped, full)).toBe(false);
    // Headline-bottom copy sits below the 0.15 strip (y=12 on an 80px canvas).
    // The clip must clear that region; the unclipped timeline frame must not.
    expect(nonRedBelow(full, 12)).toBeGreaterThan(0);
    expect(nonRedBelow(clipped, 12)).toBe(0);
  });
});
