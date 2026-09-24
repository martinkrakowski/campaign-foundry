import { describe, expect, test } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import {
  type BriefTemplate,
  type CompositeRequest,
  type CreativeTemplateLayer,
} from "@campaignfoundry/CampaignOrchestration";
import type { CanvasSpec } from "@campaignfoundry/CampaignOrchestration/aspect-ratios";
import type { LayerFrame } from "@campaignfoundry/CampaignOrchestration/creative-geometry";
import { NodeCanvasCompositor } from "../NodeCanvasCompositor.js";

import { projectRoot } from "@campaignfoundry/shared";
/**
 * L11 / D131: a `fill` layer paints a BRAND ROLE over its own frame.
 *
 * The worked example D131 states is the one this file renders: a picture in the
 * top half, a solid brand band in the bottom half, the copy over the band. The
 * claim that matters is that the band is a band — the fill owns its frame and
 * nothing above it — because a fill that ignored its frame would paint the
 * whole canvas and swallow the picture, which is the defect a structural
 * "paintFill was called" assertion cannot see.
 */

const RED = "#cc0000";
const RED_RGB: readonly [number, number, number] = [0xcc, 0, 0];
/** The brief's brand colour — what `role: "primary"` must resolve to. */
const BRAND = "#1473E6";
const BRAND_RGB: readonly [number, number, number] = [0x14, 0x73, 0xe6];
/** A second brand, to prove the role resolves rather than pinning a literal. */
const OTHER_BRAND = "#E0218A";
const OTHER_BRAND_RGB: readonly [number, number, number] = [0xe0, 0x21, 0x8a];

const redBackground = (width: number, height: number): Uint8Array => {
  const c = createCanvas(width, height);
  const g = c.getContext("2d");
  g.fillStyle = RED;
  g.fillRect(0, 0, width, height);
  return c.toBuffer("image/png");
};

type TemplateRequest = CompositeRequest & { readonly template?: BriefTemplate };

const request = (
  canvas: CanvasSpec,
  width: number,
  height: number,
  layers: readonly CreativeTemplateLayer[],
  brandColor: string = BRAND,
): TemplateRequest => ({
  background: redBackground(width, height),
  message: "Stay wild, stay hydrated",
  brandColor,
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

const at = (f: FramePixels, x: number, y: number): readonly [number, number, number] => {
  const i = (y * f.width + x) * 4;
  return [f.data[i]!, f.data[i + 1]!, f.data[i + 2]!];
};

const is = (
  rgb: readonly [number, number, number],
  want: readonly [number, number, number],
): boolean => rgb[0] === want[0] && rgb[1] === want[1] && rgb[2] === want[2];

/** The owner's example (D131): picture on top, brand band below, copy over it. */
const BOTTOM_HALF: LayerFrame = { x: 0, y: 0.5, w: 1, h: 0.5, anchor: "bottom" };
const TOP_HALF: LayerFrame = { x: 0, y: 0, w: 1, h: 0.5, anchor: "top" };

const ownersExample = (
  fill: Partial<CreativeTemplateLayer> = {},
): readonly CreativeTemplateLayer[] => [
  { id: "image", kind: "image", frame: TOP_HALF },
  { id: "band", kind: "fill", frame: BOTTOM_HALF, ...fill },
  { id: "shade", kind: "shade", enabled: false },
  { id: "accent", kind: "accent", enabled: false },
  { id: "static-text", kind: "static-text" },
  { id: "logo", kind: "logo", enabled: false },
];

describe("the fill layer paints a brand role over its frame (L11, D131)", () => {
  test("the owner's example: a brand band in the bottom half, the picture untouched above it", async () => {
    const f = await pixels(request({ ratio: "1:1" }, 400, 400, ownersExample()));
    // Inside the band: the brand colour, not the picture.
    expect(is(at(f, 10, 390), BRAND_RGB)).toBe(true);
    expect(is(at(f, 390, 210), BRAND_RGB)).toBe(true);
    // Above it: the picture, not the band. This is the assertion a fill that
    // ignored its frame would fail — it would have painted the whole canvas.
    expect(is(at(f, 10, 10), RED_RGB)).toBe(true);
    expect(is(at(f, 390, 190), RED_RGB)).toBe(true);
  });

  test("the role resolves against the brief's brand, never a literal", async () => {
    // Same template, different brand: the band follows the brand. A template
    // that hard-coded a colour would paint the same pixels in both.
    const mine = await pixels(request({ ratio: "1:1" }, 400, 400, ownersExample()));
    const theirs = await pixels(request({ ratio: "1:1" }, 400, 400, ownersExample(), OTHER_BRAND));
    expect(is(at(mine, 10, 390), BRAND_RGB)).toBe(true);
    expect(is(at(theirs, 10, 390), OTHER_BRAND_RGB)).toBe(true);
  });

  test("an explicit role: primary paints what the absent role paints", async () => {
    // `role` is optional and absent means `DEFAULT_FILL_ROLE` — so spelling out
    // today's only role must be byte-identical, the D134 idiom every other prop
    // in this vocabulary follows.
    const implicit = await pixels(request({ ratio: "1:1" }, 400, 400, ownersExample()));
    const explicit = await pixels(
      request({ ratio: "1:1" }, 400, 400, ownersExample({ props: { role: "primary" } })),
    );
    expect(implicit.data.every((v, i) => v === explicit.data[i])).toBe(true);
  });

  test("a frameless fill covers the canvas — LAYER_KIND_DEFAULT_RECTS.fill", async () => {
    // Absent frame is the kind's default rect, which for an opaque fill is the
    // whole canvas: the picture below is gone, deliberately.
    const f = await pixels(
      request({ ratio: "1:1" }, 400, 400, [
        { id: "image", kind: "image" },
        { id: "wash", kind: "fill" },
        { id: "shade", kind: "shade", enabled: false },
        { id: "accent", kind: "accent", enabled: false },
        { id: "static-text", kind: "static-text" },
        { id: "logo", kind: "logo", enabled: false },
      ]),
    );
    expect(is(at(f, 10, 10), BRAND_RGB)).toBe(true);
    expect(is(at(f, 390, 390), BRAND_RGB)).toBe(true);
  });

  test("a disabled fill renders what the same template without it renders (D129)", async () => {
    // Not "the band area goes back to the picture": the image here is framed to
    // the TOP half, so with the band off the bottom half is simply unpainted.
    // D129's rule is the comparison — disabled equals absent, byte for byte.
    const off = await pixels(
      request({ ratio: "1:1" }, 400, 400, ownersExample({ enabled: false })),
    );
    const absent = await pixels(
      request(
        { ratio: "1:1" },
        400,
        400,
        ownersExample().filter((layer) => layer.kind !== "fill"),
      ),
    );
    expect(off.data.every((v, i) => v === absent.data[i])).toBe(true);
    // And the band really is gone — otherwise both sides could be the band.
    expect(is(at(off, 10, 390), BRAND_RGB)).toBe(false);
  });
});
