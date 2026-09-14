import { describe, expect, test } from "vitest";
import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import {
  type BriefTemplate,
  type CompositeRequest,
  type HtmlElement,
} from "@campaignfoundry/CampaignOrchestration";
import { NodeCanvasCompositor } from "../NodeCanvasCompositor.js";

/**
 * X10: html text must not leave its own frame, in either renderer.
 *
 * Canvas text and button drawers must clip to the element's own rectangle frame
 * within the save/restore pair, so overflowing labels never paint pixels outside
 * the element frame.
 */

const WIDTH = 200;
const HEIGHT = 200;

const createBackground = (): Uint8Array => {
  const c = createCanvas(WIDTH, HEIGHT);
  const g = c.getContext("2d");
  g.fillStyle = "#000000";
  g.fillRect(0, 0, WIDTH, HEIGHT);
  return c.toBuffer("image/png");
};

function partitionPixels(
  ctx: SKRSContext2D,
  width: number,
  height: number,
  frame: { x: number; y: number; w: number; h: number },
) {
  const data = ctx.getImageData(0, 0, width, height).data;
  const boxX = Math.round(frame.x * width);
  const boxY = Math.round(frame.y * height);
  const boxW = Math.round(frame.w * width);
  const boxH = Math.round(frame.h * height);

  const outside: number[] = [];
  const inside: number[] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r = data[idx]!;
      const g = data[idx + 1]!;
      const b = data[idx + 2]!;
      const a = data[idx + 3]!;
      if (x >= boxX && x < boxX + boxW && y >= boxY && y < boxY + boxH) {
        inside.push(r, g, b, a);
      } else {
        outside.push(r, g, b, a);
      }
    }
  }

  return {
    outside: Buffer.from(outside),
    inside: Buffer.from(inside),
  };
}

async function renderHtmlElement(element: HtmlElement) {
  const template: BriefTemplate = {
    id: "canonical-image-html",
    version: 1,
    creativeType: "image-html",
    unit: "standard-web",
    layers: [{ id: "html", kind: "html", elements: [element] }],
  };

  const req: CompositeRequest & { template: BriefTemplate } = {
    background: createBackground(),
    message: "Test message",
    brandColor: "#1473E6",
    logoPath: "assets/inputs/hydra-logo.png",
    canvas: { ratio: "1:1" },
    layout: "headline-bottom",
    tone: "bold",
    pixelSize: { width: WIDTH, height: HEIGHT },
    template,
  };

  const prepared = await NodeCanvasCompositor.prepare(req);
  const ctx = createCanvas(prepared.width, prepared.height).getContext("2d");
  NodeCanvasCompositor.draw(ctx, prepared, 1);
  return { ctx, width: prepared.width, height: prepared.height };
}

/**
 * A context that records every call made on it, delegating each to a real canvas.
 * Used where a pixel comparison cannot discriminate: the label's glyph band sits at
 * 45 % of the button height, so the region between a rectangular and a rounded clip
 * is reached by at most sub-pixel anti-aliasing, and no pixel assertion bites reliably.
 */
function recordingContext(width: number, height: number) {
  const target = createCanvas(width, height).getContext("2d");
  const calls: { name: string; args: unknown[] }[] = [];
  const ctx = new Proxy(target, {
    get(t, prop, receiver) {
      const value = Reflect.get(t, prop, t);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push({ name: String(prop), args });
        return (value as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
    set(t, prop, value) {
      return Reflect.set(t, prop, value, t);
    },
  }) as SKRSContext2D;
  return { ctx, calls };
}

describe("html layer clipping (X10)", () => {
  test("a button clips to the same rounded rectangle it fills, as the markup's border-radius does", async () => {
    // The markup gives a button `border-radius: <radius>px; overflow: hidden`, which clips its label to
    // the rounded shape. The canvas must clip to that same shape, with the same radius as its own fill.
    const element: HtmlElement = {
      kind: "button",
      text: "MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM",
      frame: { x: 0.2, y: 0.2, w: 0.4, h: 0.1, anchor: "middle" },
    };
    const template: BriefTemplate = {
      id: "canonical-image-html",
      version: 1,
      creativeType: "image-html",
      unit: "standard-web",
      layers: [{ id: "html", kind: "html", elements: [element] }],
    };
    const req: CompositeRequest & { template: BriefTemplate } = {
      background: createBackground(),
      message: "Test message",
      brandColor: "#1473E6",
      logoPath: "assets/inputs/hydra-logo.png",
      canvas: { ratio: "1:1" },
      layout: "headline-bottom",
      tone: "bold",
      pixelSize: { width: WIDTH, height: HEIGHT },
      template,
    };
    const prepared = await NodeCanvasCompositor.prepare(req);
    const { ctx, calls } = recordingContext(prepared.width, prepared.height);
    NodeCanvasCompositor.draw(ctx, prepared, 1);

    const clipAt = calls.findIndex((c) => c.name === "clip");
    expect(clipAt).toBeGreaterThan(0);
    const clipShape = calls.slice(0, clipAt).reverse().find((c) => c.name === "rect" || c.name === "roundRect");
    const fillAt = calls.findIndex((c, i) => i > clipAt && c.name === "fill");
    const fillShape = calls.slice(clipAt, fillAt).reverse().find((c) => c.name === "rect" || c.name === "roundRect");

    expect(fillShape?.name).toBe("roundRect");
    expect(clipShape).toEqual(fillShape);
  });

  test("text: label far longer than its frame clips drawing to the element frame", async () => {
    const frame = { x: 0.2, y: 0.2, w: 0.6, h: 0.2, anchor: "top" as const };
    const longText =
      "This is an extraordinarily long text headline label designed specifically to exceed and overflow its frame boundaries across multiple lines";

    const { ctx: ctxOverflow, width, height } = await renderHtmlElement({
      kind: "text",
      text: longText,
      frame,
    });
    const { ctx: ctxEmpty } = await renderHtmlElement({
      kind: "text",
      text: "",
      frame,
    });

    const overflowPixels = partitionPixels(ctxOverflow, width, height, frame);
    const emptyPixels = partitionPixels(ctxEmpty, width, height, frame);

    expect(overflowPixels.outside.equals(emptyPixels.outside)).toBe(true);
    expect(overflowPixels.inside.equals(emptyPixels.inside)).toBe(false);
  });

  test("button: label far longer than its frame clips drawing to the element frame", async () => {
    const frame = { x: 0.2, y: 0.2, w: 0.4, h: 0.2, anchor: "middle" as const };
    const longText =
      "This is an extremely long button label that extends horizontally far beyond the boundaries of this button element frame";

    const { ctx: ctxOverflow, width, height } = await renderHtmlElement({
      kind: "button",
      text: longText,
      frame,
    });
    const { ctx: ctxEmpty } = await renderHtmlElement({
      kind: "button",
      text: "",
      frame,
    });

    const overflowPixels = partitionPixels(ctxOverflow, width, height, frame);
    const emptyPixels = partitionPixels(ctxEmpty, width, height, frame);

    expect(overflowPixels.outside.equals(emptyPixels.outside)).toBe(true);
    expect(overflowPixels.inside.equals(emptyPixels.inside)).toBe(false);
  });
});
