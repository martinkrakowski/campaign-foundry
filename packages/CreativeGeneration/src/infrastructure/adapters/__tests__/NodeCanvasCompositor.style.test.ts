import { describe, test, expect } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { createHash } from "node:crypto";
import {
  AspectRatio,
  type CompositeRequest,
  type CopyTimeline,
} from "@campaignfoundry/CampaignOrchestration";
import { DEFAULT_STYLE } from "@campaignfoundry/CampaignOrchestration/creative-style";
import { CREATIVE_GEOMETRY } from "@campaignfoundry/CampaignOrchestration/creative-geometry";
import { NodeCanvasCompositor } from "../NodeCanvasCompositor.js";
import { registerBundledFonts } from "../../fonts.js";

registerBundledFonts();

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

const timeline = (beats: string[], keyBeat = 1): CopyTimeline => ({
  beats: beats.map((text) => ({ text, weight: 1 })),
  transition: "cut",
  keyBeat,
});

interface TextOp {
  text: string;
  x: number;
  y: number;
  font: string;
  letterSpacing: string;
  textAlign: string;
}

interface Blit {
  fillText: TextOp[];
  raster: Buffer;
}

/**
 * Paint one prepared request through the real draw path and record every text
 * op WITH the ctx state it painted under, plus the frame's raster bytes — the
 * state controls (letterSpacing, align) are asserted on what was actually
 * drawn, never on configuration.
 */
async function blit(req: CompositeRequest, t = 1, motion?: Parameters<typeof NodeCanvasCompositor.draw>[3], copyT?: number): Promise<Blit> {
  const prepared = await NodeCanvasCompositor.prepare(req);
  const canvas = createCanvas(prepared.width, prepared.height);
  const ctx = canvas.getContext("2d");
  const fillText: TextOp[] = [];
  const origFill = ctx.fillText.bind(ctx);
  ctx.fillText = ((text: string, x: number, y: number, maxWidth?: number) => {
    fillText.push({
      text,
      x,
      y,
      font: ctx.font,
      letterSpacing: ctx.letterSpacing,
      textAlign: ctx.textAlign,
    });
    return origFill(text, x, y, maxWidth);
  }) as typeof ctx.fillText;
  NodeCanvasCompositor.draw(ctx, prepared, t, motion, copyT);
  return { fillText, raster: canvas.toBuffer("image/png") };
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

describe("NodeCanvasCompositor style block (T5) — the still path", () => {
  test("a style-less request resolves every field to today's literal (D54)", async () => {
    const prepared = await NodeCanvasCompositor.prepare(request());
    expect(prepared.style).toEqual({
      fontFamily: "Inter",
      fontWeight: "bold", // tone-derived: `bold` tone renders 700 via the Bold face
      sizeScale: CREATIVE_GEOMETRY.headlineTypeWidthFraction,
      lineHeight: DEFAULT_STYLE.lineHeight,
      letterSpacing: 0,
      align: "center",
    });
    expect(prepared.style.fontWeight).toBe("bold");
  });

  test("an absent style and an explicit empty style render identical bytes", async () => {
    const absent = await blit(request());
    const empty = await blit(request({ style: {} }));
    expect(sha256(empty.raster)).toBe(sha256(absent.raster));
  });

  test("a styled weight overrides the tone-derived one and reaches the drawn font", async () => {
    // `subtle` asks for "500" (renders Regular); the style pins 700 instead —
    // and the drawn ctx.font spells the styled weight, not the tone's.
    const subtleStyled = await blit(request({ tone: "subtle", style: { fontWeight: 700 } }));
    expect(subtleStyled.fillText[0]?.font).toMatch(/^700 \d+px /);
    // And it genuinely rasterises differently from the tone default.
    const subtle = await blit(request({ tone: "subtle" }));
    expect(sha256(subtleStyled.raster)).not.toBe(sha256(subtle.raster));
  });

  test("styled weight 400 on a bold tone renders Regular", async () => {
    const styled = await blit(request({ tone: "bold", style: { fontWeight: 400 } }));
    expect(styled.fillText[0]?.font).toMatch(/^400 /);
  });

  test("the styled family reaches the drawn font", async () => {
    const styled = await blit(request({ style: { fontFamily: "Lora" } }));
    expect(styled.fillText[0]?.font).toContain("Lora");
  });

  test("sizeScale sets the starting type size as a fraction of the canvas width (D55)", async () => {
    const r = ratio("1:1");
    const styled = await blit(request({ message: "Stay", style: { sizeScale: 0.08 } }));
    // One short line: no autofit shrink, so the drawn size IS the starting size.
    expect(styled.fillText[0]?.font).toContain(`${Math.round(r.width * 0.08)}px`);
  });

  test("lineHeight spaces the drawn lines at fontSize × the styled multiple", async () => {
    const message = "Stay wild, stay hydrated, and never stop exploring the trail ahead of you today";
    const insets = { top: 100, right: 0, bottom: 400, left: 0 };
    const styled = await blit(
      request({ message, safeInsets: insets, style: { lineHeight: 1.5 } }),
    );
    expect(styled.fillText.length).toBeGreaterThanOrEqual(2);
    const fontSize = Math.round(ratio("1:1").width * CREATIVE_GEOMETRY.headlineTypeWidthFraction);
    expect((styled.fillText[1]?.y ?? 0) - (styled.fillText[0]?.y ?? 0)).toBe(fontSize * 1.5);
  });

  test("letterSpacing shifts the raster and is set on the ctx at the blit (px = em × fontSize)", async () => {
    const styled = await blit(request({ style: { letterSpacing: 0.1 } }));
    const fontSize = Math.round(ratio("1:1").width * CREATIVE_GEOMETRY.headlineTypeWidthFraction);
    expect(styled.fillText[0]?.letterSpacing).toBe(`${0.1 * fontSize}px`);
    const plain = await blit(request());
    expect(sha256(styled.raster)).not.toBe(sha256(plain.raster));
  });

  test("align left and right draw against the safe-area edges, center keeps the legacy x (C2)", async () => {
    const insets = { top: 0, right: 60, bottom: 0, left: 40 };
    const r = ratio("1:1");
    for (const align of ["left", "right", "center"] as const) {
      const styled = await blit(request({ safeInsets: insets, style: { align } }));
      const op = styled.fillText[0];
      if (!op) throw new Error(`missing fillText for align ${align}`);
      expect(op.textAlign).toBe(align);
      if (align === "left") expect(op.x).toBe(insets.left);
      else if (align === "right") expect(op.x).toBe(r.width - insets.right);
      else expect(op.x).toBe(insets.left + (r.width - insets.left - insets.right) / 2);
    }
  });

  test("the styled size scale feeds the autofit floor arithmetic, not just the start", async () => {
    // A huge sizeScale with a long message must still autofit down and wrap —
    // the styled size is the START, and the fitting machinery bounds it.
    const styled = await blit(
      request({
        message: "Stay wild, stay hydrated, and never stop exploring the trail ahead of you today",
        safeInsets: { top: 200, right: 0, bottom: 200, left: 0 },
        style: { sizeScale: 0.12 },
      }),
    );
    const startSize = Math.round(ratio("1:1").width * 0.12);
    expect(styled.fillText.length).toBeGreaterThan(1);
    for (const op of styled.fillText) {
      const drawnSize = Number(/(\d+)px/.exec(op.font)?.[1]);
      expect(drawnSize).toBeLessThan(startSize);
    }
  });
});

describe("NodeCanvasCompositor style block (T5) — the timeline path (F5a)", () => {
  const timelineRequest = (over: Partial<TimelineRequest>): TimelineRequest => ({
    ...request(),
    durationSec: 8,
    timeline: timeline(["Alpha", "Beta"], 1),
    ...over,
  });

  test("letterSpacing is applied on a DRAWN timeline frame, not only a still (F5a)", async () => {
    // The timeline path measures on a throwaway 1×1 context and drawBeat re-sets
    // ctx.font — a ctx-state control applied only on the still path would
    // silently drop here. Assert the ctx state at the blit AND the raster.
    const spaced = await blit(timelineRequest({ style: { letterSpacing: 0.1 } }), 0.5, undefined, 0.5);
    const fontSize = Math.round(ratio("1:1").width * CREATIVE_GEOMETRY.headlineTypeWidthFraction);
    expect(spaced.fillText.length).toBeGreaterThan(0);
    for (const op of spaced.fillText) {
      expect(op.letterSpacing).toBe(`${0.1 * fontSize}px`);
    }
    const plain = await blit(timelineRequest({}), 0.5, undefined, 0.5);
    expect(sha256(spaced.raster)).not.toBe(sha256(plain.raster));
  });

  test("align reaches the drawn timeline frame against the safe area", async () => {
    const insets = { top: 0, right: 60, bottom: 0, left: 40 };
    const r = ratio("1:1");
    const styled = await blit(
      timelineRequest({ safeInsets: insets, style: { align: "left" } }),
      0.5,
      undefined,
      0.5,
    );
    expect(styled.fillText[0]?.textAlign).toBe("left");
    expect(styled.fillText[0]?.x).toBe(insets.left);
    // Contrast: the centred default draws at the safe-area centre.
    const centred = await blit(timelineRequest({ safeInsets: insets }), 0.5, undefined, 0.5);
    expect(centred.fillText[0]?.x).toBe(insets.left + (r.width - insets.left - insets.right) / 2);
  });

  test("a styled weight/family reach every drawn beat's font", async () => {
    const styled = await blit(
      timelineRequest({ tone: "subtle", style: { fontWeight: 700, fontFamily: "Lora" } }),
      0.5,
      undefined,
      0.5,
    );
    for (const op of styled.fillText) {
      expect(op.font).toMatch(/^700 /);
      expect(op.font).toContain("Lora");
    }
  });
});
