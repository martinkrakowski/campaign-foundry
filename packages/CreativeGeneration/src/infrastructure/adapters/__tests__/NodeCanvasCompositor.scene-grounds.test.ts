import { describe, test, expect } from "vitest";
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import {
  resolveTimeline,
  restT,
  type CompositeRequest,
  type CopyTimeline,
} from "@campaignfoundry/CampaignOrchestration";
import { NodeCanvasCompositor } from "../NodeCanvasCompositor.js";

/**
 * VE5b1 — the renderer paints a per-beat ground when the request supplies one
 * (VE5b — Scenes in the renderer, docs/planning/2026-09-13_video-editing-features.md).
 *
 * Every request here uses solid-colour PNGs: cover-fit and ken-burns only ever
 * scale/crop a uniform field, so a corner pixel — sampled away from the shade
 * gradient (starts at 0.45h) and the bottom-anchored accent band, both true for
 * `headline-bottom` — reads the ground colour exactly, whatever the canvas size.
 */

const WIDTH = 64;
const HEIGHT = 64;

const solidPng = (hex: string): Uint8Array => {
  const c = createCanvas(8, 8);
  const g = c.getContext("2d");
  g.fillStyle = hex;
  g.fillRect(0, 0, 8, 8);
  return c.toBuffer("image/png");
};

const GROUND = solidPng("#333333"); // the creative's own background
const SCENE_A = solidPng("#ff0000");
const SCENE_B = solidPng("#0000ff");

type SceneRequest = CompositeRequest & {
  readonly durationSec?: number;
  readonly timeline?: CopyTimeline;
  readonly backgrounds?: Readonly<Record<string, Uint8Array>>;
};

const request = (over: Partial<SceneRequest> = {}): SceneRequest => ({
  background: GROUND,
  message: "Stay wild, stay hydrated",
  brandColor: "#1473E6",
  logoPath: "no-such-logo.png", // ENOENT: the logo skips cleanly (F2), nothing to avoid sampling
  canvas: { ratio: "1:1" },
  pixelSize: { width: WIDTH, height: HEIGHT },
  layout: "headline-bottom",
  tone: "bold",
  ...over,
});

function cornerPixel(canvas: Canvas): readonly [number, number, number, number] {
  const data = canvas.getContext("2d").getImageData(1, 1, 1, 1).data;
  return [data[0]!, data[1]!, data[2]!, data[3]!];
}

async function drawAt(
  req: SceneRequest,
  t: number,
  motion?: "ken-burns-in",
  copyT?: number,
): Promise<Canvas> {
  const prepared = await NodeCanvasCompositor.prepare(req);
  const canvas = createCanvas(prepared.width, prepared.height);
  const ctx = canvas.getContext("2d");
  NodeCanvasCompositor.draw(ctx, prepared, t, motion, copyT, 1);
  return canvas;
}

const twoBeatTimeline = (transition: "cut" | "fade", keyBeat = 1): CopyTimeline => ({
  beats: [
    { text: "Scene A", weight: 1, background: "scene-a.png" },
    { text: "Scene B", weight: 1, background: "scene-b.png" },
  ],
  transition,
  keyBeat,
});

const DURATION_SEC = 10;
const BACKGROUNDS = { "scene-a.png": SCENE_A, "scene-b.png": SCENE_B };

describe("NodeCanvasCompositor scene grounds (VE5b1)", () => {
  test("cut: the ground switches exactly at the resolved beat boundary, the boundary instant itself belonging to the incoming beat (beatAt's half-open window)", async () => {
    const timeline = twoBeatTimeline("cut");
    const resolved = resolveTimeline(timeline, DURATION_SEC);
    const boundary = resolved[0].endT;
    const req = request({ durationSec: DURATION_SEC, timeline, backgrounds: BACKGROUNDS });

    const before = await drawAt(req, boundary - 1e-6, undefined, boundary - 1e-6);
    // `beatAt` selects a beat by `t < endT`, so beat 0's window is half-open on
    // the right: `t === boundary` is already past it and lands on beat 1 —
    // asserted here directly, not just just-before/just-after, so an
    // implementation that keeps beat 0 exactly at the boundary cannot pass.
    const atBoundary = await drawAt(req, boundary, undefined, boundary);
    const after = await drawAt(req, boundary + 1e-6, undefined, boundary + 1e-6);

    expect(cornerPixel(before)).toEqual([0xff, 0, 0, 0xff]);
    expect(cornerPixel(atBoundary)).toEqual([0, 0, 0xff, 0xff]);
    expect(cornerPixel(after)).toEqual([0, 0, 0xff, 0xff]);
  });

  test("fade: at the crossfade midpoint the ground is the mix of both scenes (8-bit rounding tolerance)", async () => {
    const timeline = twoBeatTimeline("fade");
    const resolved = resolveTimeline(timeline, DURATION_SEC);
    const mid = resolved[1].startT + resolved[1].fadeInT / 2;
    expect(resolved[1].fadeInT).toBeGreaterThan(0);
    const req = request({ durationSec: DURATION_SEC, timeline, backgrounds: BACKGROUNDS });

    const canvas = await drawAt(req, mid, undefined, mid);
    const [r, g, b, a] = cornerPixel(canvas);
    // mix ≈ 0.5: A (255,0,0) under B (0,0,255) at globalAlpha 0.5 ⇒ ≈(128,0,128).
    expect(r).toBeGreaterThanOrEqual(125);
    expect(r).toBeLessThanOrEqual(130);
    expect(g).toBe(0);
    expect(b).toBeGreaterThanOrEqual(125);
    expect(b).toBeLessThanOrEqual(130);
    expect(a).toBe(0xff);
  });

  test("poster: the key beat's scene shows, through the same copyT selection the poster call uses — no poster-specific branch", async () => {
    const timeline = twoBeatTimeline("cut", 2);
    const resolved = resolveTimeline(timeline, DURATION_SEC);
    const keyBeat = resolved[timeline.keyBeat - 1];
    const posterCopyT = (keyBeat.startT + keyBeat.endT) / 2;
    const req = request({ durationSec: DURATION_SEC, timeline, backgrounds: BACKGROUNDS });

    // The exact call shape CanvasFfmpegVideoCompositor's poster uses (D7):
    // rest pose, key-beat mid-window copy clock, settled effect clock.
    const canvas = await drawAt(req, restT("ken-burns-in"), "ken-burns-in", posterCopyT);
    expect(cornerPixel(canvas)).toEqual([0, 0, 0xff, 0xff]);
  });

  test("a beat naming a background absent from the request falls back to the creative's own ground (VE-D3)", async () => {
    const timeline: CopyTimeline = {
      beats: [{ text: "Scene A", weight: 1, background: "missing.png" }],
      transition: "cut",
      keyBeat: 1,
    };
    const req = request({
      durationSec: DURATION_SEC,
      timeline,
      backgrounds: { "scene-a.png": SCENE_A }, // "missing.png" has no entry
    });

    const canvas = await drawAt(req, 0.5, undefined, 0.5);
    expect(cornerPixel(canvas)).toEqual([0x33, 0x33, 0x33, 0xff]);
  });

  test("prepare decodes only the backgrounds a beat actually references — an unreferenced, undecodable entry never aborts the render (review finding)", async () => {
    const timeline: CopyTimeline = {
      beats: [{ text: "Scene A", weight: 1, background: "scene-a.png" }],
      transition: "cut",
      keyBeat: 1,
    };
    // Not a PNG at all — @napi-rs/canvas's loadImage rejects on it. No beat
    // names "unreferenced.png", so it must never reach loadImage: if prepare()
    // decoded the whole map instead of only the referenced entries, this
    // request would reject instead of rendering.
    const GARBAGE = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
    const req = request({
      durationSec: DURATION_SEC,
      timeline,
      backgrounds: { "scene-a.png": SCENE_A, "unreferenced.png": GARBAGE },
    });

    const canvas = await drawAt(req, 0.5, undefined, 0.5);
    expect(cornerPixel(canvas)).toEqual([0xff, 0, 0, 0xff]);
  });

  test("a mixed timeline: the sceneless beat paints the creative's own ground while its neighbour paints its scene", async () => {
    // Beat 1 names a scene; beat 2 names none at all — distinct from "names one
    // absent from the map" above (that beat's `background` is always defined).
    const timeline: CopyTimeline = {
      beats: [
        { text: "Scene A", weight: 1, background: "scene-a.png" },
        { text: "No Scene", weight: 1 },
      ],
      transition: "cut",
      keyBeat: 1,
    };
    const resolved = resolveTimeline(timeline, DURATION_SEC);
    const req = request({
      durationSec: DURATION_SEC,
      timeline,
      backgrounds: { "scene-a.png": SCENE_A },
    });

    const inSceneBeat = await drawAt(
      req,
      resolved[0].startT + 0.01,
      undefined,
      resolved[0].startT + 0.01,
    );
    const inScenelessBeat = await drawAt(
      req,
      resolved[1].startT + 0.01,
      undefined,
      resolved[1].startT + 0.01,
    );

    expect(cornerPixel(inSceneBeat)).toEqual([0xff, 0, 0, 0xff]);
    expect(cornerPixel(inScenelessBeat)).toEqual([0x33, 0x33, 0x33, 0xff]);
  });

  test("a fade between a scene beat and a sceneless beat crossfades the scene with the creative's own ground", async () => {
    const timeline: CopyTimeline = {
      beats: [
        { text: "Scene A", weight: 1, background: "scene-a.png" },
        { text: "No Scene", weight: 1 },
      ],
      transition: "fade",
      keyBeat: 1,
    };
    const resolved = resolveTimeline(timeline, DURATION_SEC);
    expect(resolved[1].fadeInT).toBeGreaterThan(0);
    const mid = resolved[1].startT + resolved[1].fadeInT / 2;
    const req = request({
      durationSec: DURATION_SEC,
      timeline,
      backgrounds: { "scene-a.png": SCENE_A },
    });

    const canvas = await drawAt(req, mid, undefined, mid);
    const [r, g, b, a] = cornerPixel(canvas);
    // mix ≈ 0.5: Scene A (255,0,0) outgoing, the creative's own ground
    // (0x33,0x33,0x33) incoming ⇒ ≈(153, 25.5, 25.5).
    expect(r).toBeGreaterThanOrEqual(150);
    expect(r).toBeLessThanOrEqual(157);
    expect(g).toBeGreaterThanOrEqual(22);
    expect(g).toBeLessThanOrEqual(29);
    expect(b).toBeGreaterThanOrEqual(22);
    expect(b).toBeLessThanOrEqual(29);
    expect(a).toBe(0xff);
  });

  test("VE-D3: a timeline naming no backgrounds renders identically with `backgrounds` absent and `backgrounds: {}`", async () => {
    const timeline: CopyTimeline = {
      beats: [
        { text: "Scene A", weight: 1 },
        { text: "Scene B", weight: 1 },
      ],
      transition: "fade",
      keyBeat: 1,
    };
    const absent = await drawAt(
      request({ durationSec: DURATION_SEC, timeline }),
      0.4,
      undefined,
      0.4,
    );
    const empty = await drawAt(
      request({ durationSec: DURATION_SEC, timeline, backgrounds: {} }),
      0.4,
      undefined,
      0.4,
    );
    expect(empty.toBuffer("image/png")).toEqual(absent.toBuffer("image/png"));
  });
});
