import { describe, test, expect } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import {
  DEFAULT_STYLE,
  DISPLAY_SIZE_VALUES,
  resolveCanvas,
  type CompositeRequest,
  type DisplaySize,
} from "@campaignfoundry/CampaignOrchestration";
import { CREATIVE_GEOMETRY } from "@campaignfoundry/CampaignOrchestration/creative-geometry";
import { NodeCanvasCompositor, scaleBasis, widthTermBasis } from "../NodeCanvasCompositor.js";

const THREE_LINE =
  "Stay wild, stay hydrated, and never stop exploring the trail ahead of you today";

const background = (): Uint8Array => {
  const c = createCanvas(64, 64);
  const g = c.getContext("2d");
  g.fillStyle = "#333333";
  g.fillRect(0, 0, 64, 64);
  return c.toBuffer("image/png");
};

const request = (over: Partial<CompositeRequest> = {}): CompositeRequest => ({
  background: background(),
  message: THREE_LINE,
  brandColor: "#1473E6",
  logoPath: "assets/inputs/hydra-logo.png",
  canvas: { ratio: "1:1" },
  layout: "headline-bottom",
  tone: "bold",
  ...over,
});

type LayoutCapture = {
  readonly width: number;
  readonly height: number;
  readonly fontSize: number;
  readonly lines: readonly { readonly x: number; readonly y: number; readonly text: string }[];
  readonly wrapWidth: number;
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly logo: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | undefined;
};

async function captureLayout(req: CompositeRequest): Promise<LayoutCapture> {
  const prepared = await NodeCanvasCompositor.prepare(req);
  const canvas = createCanvas(prepared.width, prepared.height);
  const ctx = canvas.getContext("2d");
  const lines: LayoutCapture["lines"][number][] = [];
  const images: { x: number; y: number; width: number; height: number }[] = [];
  const origFill = ctx.fillText.bind(ctx);
  const origDraw = ctx.drawImage.bind(ctx);
  ctx.fillText = ((text: string, x: number, y: number, maxWidth?: number) => {
    lines.push({ x, y, text });
    return origFill(text, x, y, maxWidth);
  }) as typeof ctx.fillText;
  ctx.drawImage = ((...args: Parameters<typeof ctx.drawImage>) => {
    images.push({
      x: args[1] as number,
      y: args[2] as number,
      width: args[3] as number,
      height: args[4] as number,
    });
    return origDraw(...args);
  }) as typeof ctx.drawImage;
  NodeCanvasCompositor.draw(ctx, prepared, 1);
  const fontMatch = /(\d+(?:\.\d+)?)px/.exec(ctx.font);
  const fontSize = fontMatch === null ? Number.NaN : Number(fontMatch[1]);
  const spec = req.canvas;
  const wrapBasis = widthTermBasis(spec, prepared.width, prepared.height);
  const wrapWidth = (wrapBasis - prepared.insets.left - prepared.insets.right) * 0.85;
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error("headline produced no fillText");
  }
  const boxHeight = last.y - (first.y - fontSize);
  return {
    width: prepared.width,
    height: prepared.height,
    fontSize,
    lines,
    wrapWidth,
    box: {
      x: first.x - wrapWidth / 2,
      y: first.y - fontSize,
      width: wrapWidth,
      height: boxHeight,
    },
    logo: images[1],
  };
}

function boxInsideCanvas(
  box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  width: number,
  height: number,
): void {
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
  expect(box.y + box.height).toBeLessThanOrEqual(height);
}

describe("scaleBasis (D114, size family vs ratio family)", () => {
  test("the ratio family is width, so 16:9 stays D55", () => {
    expect(scaleBasis({ ratio: "16:9" }, 1920, 1080)).toBe(1920);
    expect(scaleBasis({ ratio: "1:1" }, 1080, 1080)).toBe(1080);
    expect(scaleBasis({ ratio: "9:16" }, 1080, 1920)).toBe(1080);
  });

  test("the size family is the short side", () => {
    expect(scaleBasis({ size: "728x90" }, 728, 90)).toBe(90);
    expect(scaleBasis({ size: "160x600" }, 160, 600)).toBe(160);
    expect(scaleBasis({ size: "320x50" }, 320, 50)).toBe(50);
    expect(scaleBasis({ size: "300x250" }, 300, 250)).toBe(250);
    expect(scaleBasis({ size: "300x600" }, 300, 600)).toBe(300);
  });
});

describe("widthTermBasis — wrap/margin may use w, capped by the long side (size family only)", () => {
  test("ratio family is width, matching scaleBasis", () => {
    expect(widthTermBasis({ ratio: "16:9" }, 1920, 1080)).toBe(1920);
  });

  test("a 728×90 wraps across its width (the long side equals w)", () => {
    expect(widthTermBasis({ size: "728x90" }, 728, 90)).toBe(728);
  });

  test("a 160×600 is capped at w so wrap cannot use the 600 px long side", () => {
    expect(widthTermBasis({ size: "160x600" }, 160, 600)).toBe(160);
  });
});

describe("display layout (D114)", () => {
  test("a 728×90 render fits ≤ 2 headline lines at ≥ the floor size with the copy box inside the canvas", async () => {
    const spec = { size: "728x90" as const };
    const { width, height } = resolveCanvas(spec);
    const captured = await captureLayout(request({ canvas: spec, message: THREE_LINE }));
    const start = Math.round(scaleBasis(spec, width, height) * DEFAULT_STYLE.sizeScale);
    const floor = Math.round(start * CREATIVE_GEOMETRY.headlineTypeFloorFraction);
    expect(captured.width).toBe(728);
    expect(captured.height).toBe(90);
    expect(captured.fontSize).toBe(start);
    expect(captured.fontSize).toBeGreaterThanOrEqual(floor);
    expect(captured.lines.length).toBeLessThanOrEqual(2);
    expect(captured.lines.some((line) => line.text.includes("…"))).toBe(false);
    boxInsideCanvas(captured.box, captured.width, captured.height);
    if (captured.logo !== undefined) {
      boxInsideCanvas(captured.logo, captured.width, captured.height);
    }
  });

  test("a 160×600 type stays at the short-side floor and the headline box stays inside the canvas", async () => {
    const spec = { size: "160x600" as const };
    const { width, height } = resolveCanvas(spec);
    const captured = await captureLayout(request({ canvas: spec, message: THREE_LINE }));
    const start = Math.round(scaleBasis(spec, width, height) * DEFAULT_STYLE.sizeScale);
    const floor = Math.round(start * CREATIVE_GEOMETRY.headlineTypeFloorFraction);
    expect(captured.fontSize).toBeGreaterThanOrEqual(floor);
    expect(captured.fontSize).toBe(start);
    expect(captured.wrapWidth).toBe(width * 0.85);
    expect(captured.box.width).toBeLessThanOrEqual(width);
    boxInsideCanvas(captured.box, captured.width, captured.height);
  });

  test("a 320×50 render does not throw and keeps the headline inside the canvas", async () => {
    const spec = { size: "320x50" as const };
    const captured = await captureLayout(request({ canvas: spec, message: THREE_LINE }));
    expect(captured.width).toBe(320);
    expect(captured.height).toBe(50);
    expect(captured.lines.length).toBeGreaterThan(0);
    for (const line of captured.lines) {
      expect(line.y).toBeGreaterThanOrEqual(0);
      expect(line.y).toBeLessThanOrEqual(captured.height);
    }
    boxInsideCanvas(captured.box, captured.width, captured.height);
  });

  test("pixelSize overrides resolveCanvas so the video suite can shrink a 9:16", async () => {
    const prepared = await NodeCanvasCompositor.prepare(
      request({ canvas: { ratio: "9:16" }, pixelSize: { width: 108, height: 192 }, message: "Hi" }),
    );
    expect(prepared.width).toBe(108);
    expect(prepared.height).toBe(192);
  });

  test("every display size resolves through CanvasSpec and paints", async () => {
    for (const size of DISPLAY_SIZE_VALUES) {
      const spec = { size } satisfies { size: DisplaySize };
      const { width, height } = resolveCanvas(spec);
      const captured = await captureLayout(request({ canvas: spec, message: "Stay wild" }));
      expect(captured.width).toBe(width);
      expect(captured.height).toBe(height);
      boxInsideCanvas(captured.box, width, height);
    }
  });
});
