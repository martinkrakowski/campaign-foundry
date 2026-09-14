import { describe, test, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { VideoCompositeRequest, CopyTimeline } from "@campaignfoundry/CampaignOrchestration";
import { NodeCanvasCompositor } from "../NodeCanvasCompositor.js";
import { CanvasFfmpegVideoCompositor, type FfmpegSpawn } from "../CanvasFfmpegVideoCompositor.js";

/**
 * VE2 — the scrub seam's fidelity fence (VE-D6).
 *
 * Encoded frame `i` is `draw(ctx, prepared, i / (frames − 1), motion)` with the
 * copy and effect clocks OMITTED. The poster and the editor's still pass
 * `effectT = 1` and are not the model — so `compositeFrame` is compared against
 * the RAW RGBA the encoder receives on stdin (a capturing spawn), not against a
 * poster and not against a visual judgement.
 */

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const WIDTH = 108;
const HEIGHT = 192;
const FRAME_BYTES = WIDTH * HEIGHT * 4;

const background = (): Uint8Array => {
  const c = createCanvas(WIDTH, HEIGHT);
  c.getContext("2d").fillRect(0, 0, WIDTH, HEIGHT);
  return c.toBuffer("image/png");
};

/** Two beats so the copy clock is live, a text effect so the effect clock is live. */
const timeline: CopyTimeline = {
  beats: [
    { text: "Alpha", weight: 1 },
    { text: "Beta", weight: 1 },
  ],
  transition: "fade",
  keyBeat: 1,
};

const scrubRequest = (over: Partial<VideoCompositeRequest> = {}): VideoCompositeRequest => ({
  background: background(),
  message: "Hi",
  brandColor: "#1473E6",
  logoPath: "assets/inputs/hydra-logo.png",
  canvas: { ratio: "9:16" },
  pixelSize: { width: WIDTH, height: HEIGHT },
  layout: "headline-bottom",
  tone: "bold",
  durationSec: 2,
  fps: 12,
  motion: "ken-burns-in",
  sampleAt: [],
  timeline,
  style: { textEffect: "fade-in" },
  ...over,
});

/** A spawn that RECORDS every stdin byte instead of discarding them. */
const capturingSpawn = (chunks: Buffer[]): FfmpegSpawn => {
  return (_command, args) => {
    const outPath = args[args.length - 1];
    const stdin = new PassThrough({ highWaterMark: 1024 * 1024 });
    stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const proc = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      killed: false,
      kill() {
        proc.killed = true;
        queueMicrotask(() => proc.emit("close", 1, null));
        return true;
      },
    });
    stdin.on("finish", () => {
      setTimeout(() => {
        stderr.end();
        stdout.end();
        writeFileSync(outPath, Buffer.from("xxxxftypxxxxmoovxxxx"));
        proc.emit("close", 0);
      }, 5);
    });
    return proc as never;
  };
};

/** Decode a PNG to raw RGBA by blitting it onto an exact-size canvas. */
const decodePngToRgba = async (png: Uint8Array): Promise<Buffer> => {
  const image = await loadImage(Buffer.from(png));
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0, WIDTH, HEIGHT);
  return Buffer.from(ctx.getImageData(0, 0, WIDTH, HEIGHT).data);
};

const encodedFrameClockT = (i: number, frames: number): number => i / (frames - 1);

describe("CanvasFfmpegVideoCompositor.compositeFrame — the encoded frame, exactly (VE-D6)", () => {
  afterEach(() => vi.restoreAllMocks());

  test("compositeFrame(atSec) bytes equal encoder stdin frame i at i × w × h × 4, at 0, the middle and durationSec", async () => {
    const durationSec = 2;
    const fps = 12;
    const frames = durationSec * fps; // 24
    const chunks: Buffer[] = [];
    const compositor = new CanvasFfmpegVideoCompositor({
      spawn: capturingSpawn(chunks),
      ffmpegPath: "/opt/ffmpeg",
    });
    const request = scrubRequest({ durationSec, fps });

    const spy = vi.spyOn(NodeCanvasCompositor, "draw");
    const encode = await compositor.compositeVideo(request);
    const stdin = Buffer.concat(chunks);
    expect(stdin.byteLength).toBe(frames * FRAME_BYTES);

    // The encoder's per-frame clock, pinned independently of production code:
    // frame i draws at i / (frames − 1) with NO copy clock and NO effect clock.
    // (Named-mutation fence: `i / (frames − 1)` → `i / frames` must land here.)
    const encodeCalls = spy.mock.calls.slice(0, frames);
    expect(encodeCalls).toHaveLength(frames);
    encodeCalls.forEach((call, i) => {
      expect(call[2]).toBe(encodedFrameClockT(i, frames));
      expect(call[3]).toBe("ken-burns-in");
      expect(call[4]).toBeUndefined();
      expect(call[5]).toBeUndefined();
    });
    // The poster is NOT the model: it settles the effect clock (and moves the
    // copy clock to the key beat). If compositeFrame copied it, the byte
    // comparisons below would fail — this pins why that contrast exists.
    const posterCall = spy.mock.calls[frames];
    expect(posterCall[5]).toBe(1);
    expect(encode.poster.byteLength).toBeGreaterThan(0);

    for (const atSec of [0, 1, durationSec]) {
      spy.mockClear();
      const frame = await compositor.compositeFrame(request, atSec);

      // The frame index and its clock, computed HERE independently.
      const i = Math.round((atSec / durationSec) * (frames - 1));
      const drawCall = spy.mock.calls[0];
      if (!drawCall) throw new Error(`compositeFrame(${atSec}) drew nothing`);
      expect(spy.mock.calls).toHaveLength(1);
      expect(drawCall[2]).toBe(encodedFrameClockT(i, frames));
      expect(drawCall[4]).toBeUndefined();
      expect(drawCall[5]).toBeUndefined();

      const slice = stdin.subarray(i * FRAME_BYTES, (i + 1) * FRAME_BYTES);
      // Skia surfaces are premultiplied: the PNG round-trip is only lossless
      // while every alpha byte is 255 — check the slice, never assume.
      for (let p = 3; p < slice.byteLength; p += 4) {
        expect(slice[p]).toBe(255);
      }
      const decoded = await decodePngToRgba(frame.image);
      expect(decoded.equals(slice)).toBe(true);
      expect(Array.from(frame.image.slice(0, 4))).toEqual(PNG_MAGIC);
    }

  });

  test("a motion frame at restT-settled time is not the poster — the poster call is not the model", async () => {
    const chunks: Buffer[] = [];
    const compositor = new CanvasFfmpegVideoCompositor({
      spawn: capturingSpawn(chunks),
      ffmpegPath: "/opt/ffmpeg",
    });
    const request = scrubRequest();
    const encode = await compositor.compositeVideo(request);
    const last = await compositor.compositeFrame(request, 2);
    // keyBeat 1 sits at the clip's start; frame 23 (t = 1) sits on beat 2 with a
    // live effect clock — a compositeFrame that copied the poster's call could
    // not produce these bytes.
    expect(Buffer.from(last.image).equals(Buffer.from(encode.poster))).toBe(false);
  });

  test("compositeFrame never spawns ffmpeg and needs no ffmpegPath", async () => {
    const compositor = new CanvasFfmpegVideoCompositor({
      spawn: (() => {
        throw new Error("compositeFrame must not spawn ffmpeg");
      }) as FfmpegSpawn,
      ffmpegPath: null,
    });
    const frame = await compositor.compositeFrame(scrubRequest(), 1);
    expect(Array.from(frame.image.slice(0, 4))).toEqual(PNG_MAGIC);
    expect(frame.logoApplied).toBe(true);
  });

  test.each([
    [-0.1, /atSec must be a finite number in \[0, 2\]/],
    [2.0001, /atSec must be a finite number in \[0, 2\]/],
    [Number.NaN, /atSec must be a finite number in \[0, 2\]/],
    ["1" as unknown as number, /atSec must be a finite number in \[0, 2\]/],
  ])("rejects atSec %s with a named validation error", async (atSec, message) => {
    const compositor = new CanvasFfmpegVideoCompositor({
      spawn: (() => {
        throw new Error("must not spawn");
      }) as FfmpegSpawn,
      ffmpegPath: null,
    });
    await expect(compositor.compositeFrame(scrubRequest(), atSec)).rejects.toThrow(message);
  });

  test("rejects an under-frames request and an out-of-contract fps like compositeVideo does", async () => {
    const compositor = new CanvasFfmpegVideoCompositor({
      spawn: (() => {
        throw new Error("must not spawn");
      }) as FfmpegSpawn,
      ffmpegPath: null,
    });
    await expect(compositor.compositeFrame(scrubRequest({ durationSec: 0.05 }), 0)).rejects.toThrow(
      /durationSec \* fps must yield at least 2 frames|durationSec must be a finite number/,
    );
    await expect(compositor.compositeFrame(scrubRequest({ fps: 0 }), 0)).rejects.toThrow(/fps must be an integer/);
  });

  test("reports the logo verdict the still path reports", async () => {
    const compositor = new CanvasFfmpegVideoCompositor({
      spawn: (() => {
        throw new Error("must not spawn");
      }) as FfmpegSpawn,
      ffmpegPath: null,
    });
    const frame = await compositor.compositeFrame(
      scrubRequest({ logoPath: "assets/inputs/missing-logo.png" }),
      1,
    );
    expect(frame.logoApplied).toBe(false);
  });
});
