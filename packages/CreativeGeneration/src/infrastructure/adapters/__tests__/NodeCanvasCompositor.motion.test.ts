import { describe, test, expect } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { AspectRatio, type CompositeRequest, type MotionKind } from "@campaignfoundry/CampaignOrchestration";
import { NodeCanvasCompositor } from "../NodeCanvasCompositor.js";

const ratio = (v = "1:1") => {
  const r = AspectRatio.create(v);
  if (!r.success) throw r.error;
  return r.value;
};

const background = (): Uint8Array => {
  const c = createCanvas(64, 64);
  const g = c.getContext("2d");
  g.fillStyle = "#333333";
  g.fillRect(0, 0, 64, 64);
  return c.toBuffer("image/png");
};

const request = (over: Partial<CompositeRequest> = {}): CompositeRequest => ({
  background: background(),
  message: "Stay wild, stay hydrated",
  brandColor: "#1473E6",
  logoPath: "assets/inputs/hydra-logo.png",
  ratio: ratio("1:1"),
  layout: "headline-bottom",
  tone: "bold",
  ...over,
});

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

interface DrawSpy {
  scales: number[][];
  translates: number[][];
  fillRects: number[][];
  alphas: number[];
  width: number;
  height: number;
}

async function spyDraw(req: CompositeRequest, t: number, motion?: MotionKind): Promise<DrawSpy> {
  const prepared = await NodeCanvasCompositor.prepare(req);
  const canvas = createCanvas(prepared.width, prepared.height);
  const ctx = canvas.getContext("2d");
  const scales: number[][] = [];
  const translates: number[][] = [];
  const fillRects: number[][] = [];
  const alphas: number[] = [];
  const origScale = ctx.scale.bind(ctx);
  const origTranslate = ctx.translate.bind(ctx);
  const origFill = ctx.fillRect.bind(ctx);
  ctx.scale = ((x: number, y: number) => {
    scales.push([x, y]);
    return origScale(x, y);
  }) as typeof ctx.scale;
  ctx.translate = ((x: number, y: number) => {
    translates.push([x, y]);
    return origTranslate(x, y);
  }) as typeof ctx.translate;
  ctx.fillRect = ((x: number, y: number, w: number, h: number) => {
    fillRects.push([x, y, w, h]);
    return origFill(x, y, w, h);
  }) as typeof ctx.fillRect;
  const proto = Object.getPrototypeOf(ctx) as object;
  const desc = Object.getOwnPropertyDescriptor(proto, "globalAlpha") ?? Object.getOwnPropertyDescriptor(ctx, "globalAlpha");
  Object.defineProperty(ctx, "globalAlpha", {
    configurable: true,
    get() {
      return desc?.get?.call(ctx) ?? 1;
    },
    set(v: number) {
      alphas.push(v);
      desc?.set?.call(ctx, v);
    },
  });
  NodeCanvasCompositor.draw(ctx, prepared, t, motion);
  return { scales, translates, fillRects, alphas, width: prepared.width, height: prepared.height };
}

describe("NodeCanvasCompositor.draw motion", () => {
  test("omitted motion ignores t and does not scale or fade the headline", async () => {
    const atZero = await spyDraw(request(), 0);
    expect(atZero.scales).toEqual([]);
    expect(atZero.alphas).toEqual([]);
    expect(atZero.translates.filter((p) => p[0] === 0 && p[1] !== 0)).toEqual([]);
  });

  test.each([0, 0.5, 1] as const)("ken-burns-in scale at t=%s eases 1.08 toward 1.00", async (t) => {
    const { scales } = await spyDraw(request(), t, "ken-burns-in");
    const expected = 1 + 0.08 * (1 - easeOutCubic(t));
    if (expected === 1) expect(scales).toEqual([]);
    else expect(scales).toEqual([[expected, expected]]);
  });

  test.each([0, 0.5, 1] as const)("ken-burns-out scale at t=%s eases 1.00 toward 1.08", async (t) => {
    const { scales } = await spyDraw(request(), t, "ken-burns-out");
    const expected = 1 + 0.08 * easeOutCubic(t);
    if (expected === 1) expect(scales).toEqual([]);
    else expect(scales).toEqual([[expected, expected]]);
  });

  test("ken-burns translates about the canvas centre before scaling", async () => {
    const { translates, width, height } = await spyDraw(request(), 0, "ken-burns-in");
    expect(translates[0]).toEqual([width / 2, height / 2]);
    expect(translates[1]).toEqual([-width / 2, -height / 2]);
  });

  test.each([0, 0.5, 1] as const)("headline-rise at t=%s eases alpha 0→1 and y-offset 12%→0", async (t) => {
    const { alphas, translates, height } = await spyDraw(request(), t, "headline-rise");
    const eased = easeOutCubic(t);
    const dy = (1 - eased) * 0.12 * height;
    if (dy === 0 && eased === 1) {
      expect(alphas).toEqual([]);
      expect(translates.filter((p) => p[0] === 0)).toEqual([]);
    } else {
      expect(alphas).toEqual([eased]);
      expect(translates).toContainEqual([0, dy]);
    }
  });

  test.each([0, 0.5, 1] as const)("accent-wipe bottom layout at t=%s sweeps the fade height", async (t) => {
    const { fillRects, width, height } = await spyDraw(request(), t, "accent-wipe");
    const solidH = height * 0.05;
    const fadeH = height * 0.06;
    const wipe = easeOutCubic(t);
    expect(fillRects).toContainEqual([0, height - solidH, width, solidH]);
    const fade = fillRects.find((r) => r[0] === 0 && r[2] === width && r[3] === fadeH * wipe && r[1] !== 0);
    if (wipe === 0) expect(fade).toBeUndefined();
    else expect(fade).toEqual([0, height - solidH - fadeH * wipe, width, fadeH * wipe]);
  });

  test.each([0, 0.5, 1] as const)("accent-wipe top layout at t=%s keeps the solid band and sweeps the fade", async (t) => {
    const { fillRects, width, height } = await spyDraw(request({ layout: "headline-top" }), t, "accent-wipe");
    const solidH = height * 0.05;
    const fadeH = height * 0.06;
    const wipe = easeOutCubic(t);
    expect(fillRects).toContainEqual([0, 0, width, solidH]);
    const fade = fillRects.find((r) => r[1] === solidH && r[2] === width);
    if (wipe === 0) expect(fade).toBeUndefined();
    else expect(fade).toEqual([0, solidH, width, fadeH * wipe]);
  });

  test("headline-rise re-runs logo overlap against the translated headline box", async () => {
    const insets = { top: 200, right: 0, bottom: 200, left: 0 };
    const r = ratio("16:9");
    const message = "Stay wild, stay hydrated, and never stop exploring the trail ahead of you today";
    const rest = await spyDraw(
      request({ layout: "headline-top", ratio: r, message, safeInsets: insets }),
      1,
      "headline-rise",
    );
    const rising = await spyDraw(
      request({ layout: "headline-top", ratio: r, message, safeInsets: insets }),
      0,
      "headline-rise",
    );
    expect(rising.translates).toContainEqual([0, 0.12 * r.height]);
    expect(rest.translates.filter((p) => p[0] === 0 && p[1] !== 0)).toEqual([]);
  });
});
