import { describe, test, expect } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { AspectRatio, type CompositeRequest } from "@campaignfoundry/CampaignOrchestration";
import { NodeCanvasCompositor } from "../NodeCanvasCompositor.js";

/**
 * K2's drawn-output proof: the resolved pose actually reaches the canvas —
 * not just that `groundMotionTracks`/`resolveTracks` compute the right
 * numbers in isolation (`motion-tracks.test.ts`, the domain lane). Two
 * frames of the same clip at two different pose-clock samples must differ,
 * exactly as they did before the per-kind branch moved into the domain.
 */

const ratio = () => {
  const r = AspectRatio.create("1:1");
  if (!r.success) throw r.error;
  return r.value;
};

// A gradient, not a flat fill: a solid colour is invariant under a zoom, so
// it could never show the ken-burns scale actually reaching the canvas.
const background = (): Uint8Array => {
  const c = createCanvas(64, 64);
  const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 64, 64);
  grad.addColorStop(0, "#1473E6");
  grad.addColorStop(1, "#F4C400");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return c.toBuffer("image/png");
};

const request = (): CompositeRequest => ({
  background: background(),
  message: "Stay wild, stay hydrated",
  brandColor: "#1473E6",
  logoPath: "assets/inputs/hydra-logo.png",
  canvas: { ratio: ratio().value },
  layout: "headline-bottom",
  tone: "bold",
});

async function frameAt(t: number, motion: Parameters<typeof NodeCanvasCompositor.draw>[3]): Promise<Uint8Array> {
  const prepared = await NodeCanvasCompositor.prepare(request());
  const canvas = createCanvas(prepared.width, prepared.height);
  const ctx = canvas.getContext("2d");
  NodeCanvasCompositor.draw(ctx, prepared, t, motion);
  return canvas.toBuffer("image/png");
}

describe("K2: a resolved pose reaches the canvas, not just the resolver", () => {
  test("ken-burns-in's resolved scale actually zooms the ground layer between two frames", async () => {
    const start = await frameAt(0, "ken-burns-in");
    const end = await frameAt(1, "ken-burns-in");
    expect(Buffer.compare(start, end)).not.toBe(0);
  });

  test("headline-rise's resolved dy/opacity actually moves the headline between two frames", async () => {
    const start = await frameAt(0, "headline-rise");
    const end = await frameAt(1, "headline-rise");
    expect(Buffer.compare(start, end)).not.toBe(0);
  });

  test("accent-wipe's frame at two different t still differs (K2 left the wipe drawer-local, on purpose)", async () => {
    const start = await frameAt(0, "accent-wipe");
    const end = await frameAt(1, "accent-wipe");
    expect(Buffer.compare(start, end)).not.toBe(0);
  });

  test("with no motion, t has no effect at all — the control", async () => {
    const first = await frameAt(0, undefined);
    const second = await frameAt(1, undefined);
    expect(Buffer.compare(first, second)).toBe(0);
  });
});
