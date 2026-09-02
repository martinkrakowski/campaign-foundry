import { describe, test, expect } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { createHash } from "node:crypto";
import {
  AspectRatio,
  TEXT_EFFECT_VALUES,
  type CompositeRequest,
  type CopyTimeline,
  type MotionKind,
  type TextEffectKind,
} from "@campaignfoundry/CampaignOrchestration";
import { CREATIVE_GEOMETRY } from "@campaignfoundry/CampaignOrchestration/creative-geometry";
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

type TimelineRequest = CompositeRequest & { readonly durationSec?: number; readonly timeline?: CopyTimeline };

const timelineOf = (beats: string[], keyBeat = 1): CopyTimeline => ({
  beats: beats.map((text) => ({ text, weight: 1 })),
  transition: "cut",
  keyBeat,
});

interface TextOp {
  text: string;
  /** The exact globalAlpha the op painted under (captured at the setter). */
  alpha: number;
  /** The accumulated translate the op painted under, save/restore-aware. */
  dx: number;
  dy: number;
}

interface Blit {
  prepared: Awaited<ReturnType<typeof NodeCanvasCompositor.prepare>>;
  fillText: TextOp[];
  scales: number[][];
  raster: Buffer;
}

/**
 * Paint one request through the real draw path and record every text op with
 * the pose it painted under — exact alpha (the setter, not the 8-bit read-back),
 * the accumulated translate across save/restore, and every scale call — plus
 * the frame's raster bytes. The effect is asserted on what was DRAWN, never on
 * configuration.
 */
async function blit(
  req: CompositeRequest,
  t = 1,
  motion?: MotionKind,
  copyT?: number,
): Promise<Blit> {
  const prepared = await NodeCanvasCompositor.prepare(req);
  const canvas = createCanvas(prepared.width, prepared.height);
  const ctx = canvas.getContext("2d");
  const fillText: TextOp[] = [];
  const scales: number[][] = [];
  let dx = 0;
  let dy = 0;
  const dyStack: number[] = [];
  const dxStack: number[] = [];
  // Alpha is captured at the SETTER: the canvas backend stores it 8-bit, so a
  // read-back at fillText would quantize the pose away from the pinned value.
  let lastAlpha: number | undefined;
  const proto = Object.getPrototypeOf(ctx) as object;
  const alphaDesc =
    Object.getOwnPropertyDescriptor(proto, "globalAlpha") ??
    Object.getOwnPropertyDescriptor(ctx, "globalAlpha");
  Object.defineProperty(ctx, "globalAlpha", {
    configurable: true,
    get() {
      return alphaDesc?.get?.call(ctx) ?? 1;
    },
    set(v: number) {
      lastAlpha = v;
      alphaDesc?.set?.call(ctx, v);
    },
  });
  const origFill = ctx.fillText.bind(ctx);
  const origTranslate = ctx.translate.bind(ctx);
  const origScale = ctx.scale.bind(ctx);
  const origSave = ctx.save.bind(ctx);
  const origRestore = ctx.restore.bind(ctx);
  ctx.fillText = ((text: string, x: number, y: number, maxWidth?: number) => {
    fillText.push({ text, alpha: lastAlpha ?? 1, dx, dy });
    return origFill(text, x, y, maxWidth);
  }) as typeof ctx.fillText;
  ctx.translate = ((x: number, y: number) => {
    dx += x;
    dy += y;
    return origTranslate(x, y);
  }) as typeof ctx.translate;
  ctx.scale = ((x: number, y: number) => {
    scales.push([x, y]);
    return origScale(x, y);
  }) as typeof ctx.scale;
  ctx.save = (() => {
    dxStack.push(dx);
    dyStack.push(dy);
    return origSave();
  }) as typeof ctx.save;
  ctx.restore = (() => {
    dx = dxStack.pop() ?? 0;
    dy = dyStack.pop() ?? 0;
    return origRestore();
  }) as typeof ctx.restore;
  NodeCanvasCompositor.draw(ctx, prepared, t, motion, copyT);
  return { prepared, fillText, scales, raster: canvas.toBuffer("image/png") };
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const EFFECT = CREATIVE_GEOMETRY.textEffect;
const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;

/** Mid-entrance sample: half the entrance window → the curve's own midpoint. */
const MID_T = EFFECT.entranceFraction / 2;
const SETTLED_AT_MID = easeOutCubic(0.5);

/** The pose a kind must paint at `MID_T`, derived from the one leaf source. */
function expectedPoseAtMid(kind: TextEffectKind, width: number, height: number) {
  const rest = 1 - SETTLED_AT_MID;
  switch (kind) {
    case "fade-in":
      return { alpha: SETTLED_AT_MID, dx: 0, dy: 0, scale: 1 };
    case "rise-in":
      return { alpha: 1, dx: 0, dy: rest * EFFECT.riseOffsetFraction * height, scale: 1 };
    case "slide-in":
      return { alpha: 1, dx: rest * EFFECT.slideOffsetFraction * width, dy: 0, scale: 1 };
    case "scale-in":
      return { alpha: 1, dx: 0, dy: 0, scale: 1 - rest * EFFECT.scaleAmplitude };
  }
}

describe("the text effect rides prepare (T6)", () => {
  test.each(TEXT_EFFECT_VALUES)("prepare resolves %s onto the prepared creative", async (kind) => {
    const prepared = await NodeCanvasCompositor.prepare(request({ style: { textEffect: kind } }));
    expect(prepared.textEffect).toBe(kind);
    expect(prepared.style.textEffect).toBe(kind);
  });

  test("an absent effect resolves to undefined — the pre-effect path bit for bit (D54)", async () => {
    const prepared = await NodeCanvasCompositor.prepare(request());
    expect(prepared.textEffect).toBeUndefined();
    const explicitNone = await NodeCanvasCompositor.prepare(request({ style: { textEffect: undefined } }));
    expect(explicitNone.textEffect).toBeUndefined();
  });
});

describe("the rest pose is the still's truth (H4/D54)", () => {
  test.each(TEXT_EFFECT_VALUES)(
    "at t = 1 the %s still is byte-identical to the same brief with no effect",
    async (kind) => {
      const plain = await blit(request());
      const withEffect = await blit(request({ style: { textEffect: kind } }));
      expect(sha256(withEffect.raster)).toBe(sha256(plain.raster));
    },
  );

  test.each(TEXT_EFFECT_VALUES)(
    "at t = 1 the %s timeline frame is byte-identical to the same brief with no effect",
    async (kind) => {
      const plain = await blit(timelineRequest(), 1, undefined, 1);
      const withEffect = await blit(timelineRequest({ style: { textEffect: kind } }), 1, undefined, 1);
      expect(sha256(withEffect.raster)).toBe(sha256(plain.raster));
    },
  );

  test("at restT(headline-rise) the risen headline with an effect is byte-identical to no effect", async () => {
    // The one motion kind that also moves the copy: the rest pose must hold
    // under composition too — the poster samples exactly this frame.
    const plain = await blit(request(), 1, "headline-rise");
    const withEffect = await blit(request({ style: { textEffect: "rise-in" } }), 1, "headline-rise");
    expect(sha256(withEffect.raster)).toBe(sha256(plain.raster));
  });
});

function timelineRequest(over: Partial<TimelineRequest> = {}): TimelineRequest {
  return {
    ...request(),
    durationSec: 8,
    timeline: timelineOf(["Alpha"]),
    ...over,
  };
}

describe("each kind animates the copy layer's entrance — the legacy path", () => {
  test.each(TEXT_EFFECT_VALUES)("%s paints its pose mid-entrance and moves the raster", async (kind) => {
    const r = ratio("1:1");
    const plain = await blit(request(), MID_T);
    const withEffect = await blit(request({ style: { textEffect: kind } }), MID_T);
    expect(withEffect.fillText.length).toBeGreaterThan(0);
    const expected = expectedPoseAtMid(kind, r.width, r.height);
    for (const op of withEffect.fillText) {
      expect(op.alpha).toBe(expected.alpha);
      expect(op.dx).toBeCloseTo(expected.dx, 9);
      expect(op.dy).toBeCloseTo(expected.dy, 9);
    }
    if (expected.scale === 1) {
      expect(withEffect.scales).toEqual([]);
    } else {
      expect(withEffect.scales).toEqual([[expected.scale, expected.scale]]);
    }
    // And the entrance genuinely rasterises differently from the plain brief.
    expect(sha256(withEffect.raster)).not.toBe(sha256(plain.raster));
  });

  test("the entrance settles: past the window the pose is the identity", async () => {
    const withEffect = await blit(request({ style: { textEffect: "slide-in" } }), EFFECT.entranceFraction + 0.1);
    const plain = await blit(request(), EFFECT.entranceFraction + 0.1);
    expect(sha256(withEffect.raster)).toBe(sha256(plain.raster));
  });
});

describe("each kind animates the DRAWN timeline frames too (F5a)", () => {
  test.each(TEXT_EFFECT_VALUES)("%s paints its pose on a drawn timeline frame and moves the raster", async (kind) => {
    const r = ratio("1:1");
    const plain = await blit(timelineRequest(), MID_T, undefined, MID_T);
    const withEffect = await blit(timelineRequest({ style: { textEffect: kind } }), MID_T, undefined, MID_T);
    expect(withEffect.fillText.length).toBeGreaterThan(0);
    const expected = expectedPoseAtMid(kind, r.width, r.height);
    for (const op of withEffect.fillText) {
      expect(op.alpha).toBe(expected.alpha);
      expect(op.dx).toBeCloseTo(expected.dx, 9);
      expect(op.dy).toBeCloseTo(expected.dy, 9);
    }
    expect(sha256(withEffect.raster)).not.toBe(sha256(plain.raster));
  });

  test("each beat plays the effect on its OWN window, not the clip's", async () => {
    // Beta's window starts at 0.5; a quarter of the way in its local progress
    // equals MID_T — an effect driven against the whole clip would be settled.
    const req = timelineRequest({ timeline: timelineOf(["Alpha", "Beta"]), style: { textEffect: "rise-in" } });
    const t = 0.5 + 0.5 * MID_T;
    const withEffect = await blit(req, t, undefined, t);
    expect(withEffect.fillText.map((op) => op.text)).toEqual(["Beta"]);
    const expected = expectedPoseAtMid("rise-in", 1080, 1080);
    for (const op of withEffect.fillText) {
      expect(op.dy).toBeCloseTo(expected.dy, 9);
    }
  });
});

describe("the effect composes with headline-rise (T6)", () => {
  test("translations add: headline-rise + rise-in at a mid-curve t", async () => {
    const r = ratio("1:1");
    const eased = easeOutCubic(MID_T);
    const riseDy = (1 - eased) * 0.12 * r.height;
    const effectDy = (1 - SETTLED_AT_MID) * EFFECT.riseOffsetFraction * r.height;
    const composed = await blit(request({ style: { textEffect: "rise-in" } }), MID_T, "headline-rise");
    for (const op of composed.fillText) {
      expect(op.dy).toBeCloseTo(riseDy + effectDy, 9);
      expect(op.alpha).toBe(eased);
    }
    // Contrast: the rise alone is strictly less offset — the effect is added,
    // not overridden and not clamped away.
    const riseAlone = await blit(request(), MID_T, "headline-rise");
    expect(riseAlone.fillText[0]?.dy).toBeCloseTo(riseDy, 9);
  });

  test("alphas multiply: headline-rise + fade-in at a mid-curve t", async () => {
    const eased = easeOutCubic(MID_T);
    const composed = await blit(request({ style: { textEffect: "fade-in" } }), MID_T, "headline-rise");
    for (const op of composed.fillText) {
      expect(op.alpha).toBe(eased * SETTLED_AT_MID);
      expect(op.dy).toBeCloseTo((1 - eased) * 0.12 * 1080, 9);
    }
  });

  test("on the timeline path the composition rides the beat-local clock too", async () => {
    const eased = easeOutCubic(MID_T);
    const composed = await blit(
      timelineRequest({ style: { textEffect: "fade-in" } }),
      MID_T,
      "headline-rise",
      MID_T,
    );
    for (const op of composed.fillText) {
      expect(op.alpha).toBe(eased * SETTLED_AT_MID);
    }
  });
});
