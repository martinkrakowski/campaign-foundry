import { describe, test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { AspectRatio, type VideoCompositeRequest } from "@campaignfoundry/CampaignOrchestration";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ffmpegStatic = require("ffmpeg-static") as string | null;
import {
  CanvasFfmpegVideoCompositor,
  MAX_CONCURRENT_ENCODES,
  type FfmpegSpawn,
} from "../CanvasFfmpegVideoCompositor.js";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

const ratio = () => {
  const r = AspectRatio.create("9:16");
  if (!r.success) throw r.error;
  return Object.assign(Object.create(Object.getPrototypeOf(r.value)), r.value, {
    width: 108,
    height: 192,
  }) as AspectRatio;
};

const background = (): Uint8Array => {
  const c = createCanvas(16, 16);
  c.getContext("2d").fillRect(0, 0, 16, 16);
  return c.toBuffer("image/png");
};

const videoRequest = (over: Partial<VideoCompositeRequest> = {}): VideoCompositeRequest => ({
  background: background(),
  message: "Hi",
  brandColor: "#1473E6",
  logoPath: "assets/inputs/hydra-logo.png",
  ratio: ratio(),
  layout: "headline-bottom",
  tone: "bold",
  durationSec: 2,
  fps: 12,
  motion: "ken-burns-in",
  sampleAt: [0, 1],
  ...over,
});

function fakeFfmpeg(opts: {
  code?: number | null;
  stderr?: string;
  stdout?: Buffer;
  delayMs?: number;
  writeFalse?: boolean;
  error?: unknown;
  missingStdio?: boolean;
  throwOnWrite?: unknown;
  alreadyKilled?: boolean;
  closeOnWriteThrow?: number | null;
}): FfmpegSpawn {
  return () => {
    if (opts.missingStdio) {
      const proc = Object.assign(new EventEmitter(), {
        stdin: null,
        stdout: null,
        stderr: null,
        killed: false,
        kill() {
          proc.killed = true;
          return true;
        },
      });
      return proc as never;
    }

    const stdin = new PassThrough({ highWaterMark: 1024 * 1024 });
    if (!opts.writeFalse) stdin.resume();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const proc = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      killed: Boolean(opts.alreadyKilled),
      kill() {
        proc.killed = true;
        queueMicrotask(() => proc.emit("close", opts.code ?? 1, null));
        return true;
      },
    });

    if (opts.writeFalse) {
      Object.defineProperty(stdin, "write", {
        configurable: true,
        writable: true,
        value: () => {
          queueMicrotask(() => stdin.emit("drain"));
          return false;
        },
      });
    }

    if (opts.throwOnWrite !== undefined) {
      stdin.write = (() => {
        queueMicrotask(() => proc.emit("close", opts.closeOnWriteThrow ?? 0, null));
        throw opts.throwOnWrite;
      }) as typeof stdin.write;
    }

    stdin.on("finish", () => {
      setTimeout(() => {
        if (opts.error !== undefined) {
          proc.emit("error", opts.error);
          return;
        }
        const errText = opts.stderr ?? "";
        const chunkSize = 3_000;
        for (let i = 0; i < errText.length; i += chunkSize) {
          stderr.write(errText.slice(i, i + chunkSize));
        }
        stderr.end();
        stdout.end(opts.stdout ?? Buffer.from("xxxxftypxxxxmoovxxxx"));
        proc.emit("close", opts.code ?? 0);
      }, opts.delayMs ?? 5);
    });

    return proc as never;
  };
}

const ffmpegPath = typeof ffmpegStatic === "string" ? ffmpegStatic : null;
const ffmpegProbe = ffmpegPath
  ? spawnSync(ffmpegPath, ["-version"], { encoding: "utf8", timeout: 5_000 })
  : undefined;
const ffmpegOk = ffmpegProbe?.status === 0;
const skipReason = ffmpegOk
  ? undefined
  : `ffmpeg-static binary cannot execute${ffmpegProbe?.error ? ` (${ffmpegProbe.error.message})` : ffmpegProbe ? ` (exited ${ffmpegProbe.status})` : " (path is null)"}`;

describe("CanvasFfmpegVideoCompositor", () => {
  test.skipIf(!ffmpegOk)(
    skipReason ?? "encodes a playable mp4 from 24 frames at 12 fps (108×192)",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "cf-video-"));
      try {
        const compositor = new CanvasFfmpegVideoCompositor();
        const out = await compositor.compositeVideo(videoRequest({ sampleAt: [0, 0.5, 1] }));
        writeFileSync(join(dir, "clip.mp4"), out.video);
        const bytes = Buffer.from(out.video);
        expect(bytes.includes(Buffer.from("ftyp"))).toBe(true);
        expect(bytes.includes(Buffer.from("moov"))).toBe(true);
        expect(Array.from(out.poster.slice(0, 4))).toEqual(PNG_MAGIC);
        expect(out.sampledFrames).toHaveLength(3);
        for (const frame of out.sampledFrames) {
          expect(Array.from(frame.slice(0, 4))).toEqual(PNG_MAGIC);
          const img = await loadImage(Buffer.from(frame));
          expect(img.width).toBe(108);
          expect(img.height).toBe(192);
        }
        const poster = await loadImage(Buffer.from(out.poster));
        expect(poster.width).toBe(108);
        expect(poster.height).toBe(192);
        expect(out.logoApplied).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test("rejects when durationSec * fps yields fewer than 2 frames", async () => {
    const compositor = new CanvasFfmpegVideoCompositor({ spawn: fakeFfmpeg({}), ffmpegPath: "/opt/ffmpeg" });
    await expect(compositor.compositeVideo(videoRequest({ durationSec: 0.05, fps: 12 }))).rejects.toThrow(
      /at least 2 frames/,
    );
  });

  test("rejects a non-finite frame count", async () => {
    const compositor = new CanvasFfmpegVideoCompositor({ spawn: fakeFfmpeg({}), ffmpegPath: "/opt/ffmpeg" });
    await expect(compositor.compositeVideo(videoRequest({ fps: Number.POSITIVE_INFINITY }))).rejects.toThrow(
      /at least 2 frames/,
    );
  });

  test.each([2, -0.1, Number.NaN, "x"] as const)("rejects sampleAt value %s", async (t) => {
    const compositor = new CanvasFfmpegVideoCompositor({ spawn: fakeFfmpeg({}), ffmpegPath: "/opt/ffmpeg" });
    await expect(
      compositor.compositeVideo(videoRequest({ sampleAt: [t as unknown as number] })),
    ).rejects.toThrow(/sampleAt values must be finite numbers in \[0, 1\]/);
  });

  test("rejects when ffmpeg-static path is missing", async () => {
    const compositor = new CanvasFfmpegVideoCompositor({ spawn: fakeFfmpeg({}), ffmpegPath: null });
    await expect(compositor.compositeVideo(videoRequest())).rejects.toThrow(/ffmpeg-static binary is not available/);
  });

  test("rejects when ffmpeg stdio pipes are missing", async () => {
    const compositor = new CanvasFfmpegVideoCompositor({
      spawn: fakeFfmpeg({ missingStdio: true }),
      ffmpegPath: "/opt/ffmpeg",
    });
    await expect(compositor.compositeVideo(videoRequest())).rejects.toThrow(/stdio pipes were not created/);
  });

  test("rejects a non-zero ffmpeg exit with a redacted stderr tail and no absolute paths", async () => {
    const stderr = `${"x".repeat(9_000)} failed at /opt/ffmpeg/libx264 and /usr/local/bin/helper`;
    const compositor = new CanvasFfmpegVideoCompositor({
      spawn: fakeFfmpeg({ code: 1, stderr }),
      ffmpegPath: "/opt/ffmpeg",
    });
    await expect(compositor.compositeVideo(videoRequest())).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      expect(message.length).toBeLessThanOrEqual(4_000);
      expect(message).toMatch(/failed at/);
      expect(message).not.toContain("/opt/ffmpeg");
      expect(message).not.toMatch(/(?:^|[\s'"])\//);
      return true;
    });
  });

  test("names the exit code when stderr is empty", async () => {
    const compositor = new CanvasFfmpegVideoCompositor({
      spawn: fakeFfmpeg({ code: 3, stderr: "" }),
      ffmpegPath: "/opt/ffmpeg",
    });
    await expect(compositor.compositeVideo(videoRequest())).rejects.toThrow(/ffmpeg exited 3/);
  });

  test("redacts a spawn error Error and a non-Error", async () => {
    const asError = new CanvasFfmpegVideoCompositor({
      spawn: fakeFfmpeg({ error: new Error("spawn /opt/ffmpeg ENOENT") }),
      ffmpegPath: "/opt/ffmpeg",
    });
    await expect(asError.compositeVideo(videoRequest())).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toMatch(/ENOENT/);
      expect(message).not.toContain("/opt/ffmpeg");
      return true;
    });

    const asString = new CanvasFfmpegVideoCompositor({
      spawn: fakeFfmpeg({ error: "spawn exploded" }),
      ffmpegPath: "/opt/ffmpeg",
    });
    await expect(asString.compositeVideo(videoRequest())).rejects.toThrow(/spawn exploded/);
  });

  test("surfaces a write Error after ffmpeg exits 0", async () => {
    const compositor = new CanvasFfmpegVideoCompositor({
      spawn: fakeFfmpeg({ throwOnWrite: new Error("write /opt/ffmpeg failed"), alreadyKilled: true, closeOnWriteThrow: 0 }),
      ffmpegPath: "/opt/ffmpeg",
    });
    await expect(compositor.compositeVideo(videoRequest())).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toMatch(/write ffmpeg failed/);
      expect(message).not.toContain("/opt/ffmpeg");
      return true;
    });
  });

  test("surfaces a non-Error write failure after ffmpeg exits 0", async () => {
    const compositor = new CanvasFfmpegVideoCompositor({
      spawn: fakeFfmpeg({ throwOnWrite: "pipe broke", alreadyKilled: true, closeOnWriteThrow: 0 }),
      ffmpegPath: "/opt/ffmpeg",
    });
    await expect(compositor.compositeVideo(videoRequest())).rejects.toThrow(/pipe broke/);
  });

  test("kills ffmpeg when a write throws and the process is still alive", async () => {
    const compositor = new CanvasFfmpegVideoCompositor({
      spawn: fakeFfmpeg({ throwOnWrite: new Error("epipe"), alreadyKilled: false }),
      ffmpegPath: "/opt/ffmpeg",
    });
    await expect(compositor.compositeVideo(videoRequest())).rejects.toThrow();
  });

  test("waits for stdin drain when write returns false", async () => {
    const compositor = new CanvasFfmpegVideoCompositor({
      spawn: fakeFfmpeg({ writeFalse: true }),
      ffmpegPath: "/opt/ffmpeg",
      fontFamily: "Inter",
    });
    const out = await compositor.compositeVideo(videoRequest({ sampleAt: [] }));
    expect(Buffer.from(out.video).includes(Buffer.from("ftyp"))).toBe(true);
    expect(out.sampledFrames).toEqual([]);
  });

  test("reports logoApplied false when the logo is missing", async () => {
    const compositor = new CanvasFfmpegVideoCompositor({
      spawn: fakeFfmpeg({}),
      ffmpegPath: "/opt/ffmpeg",
    });
    const out = await compositor.compositeVideo(videoRequest({ logoPath: "assets/inputs/missing-logo.png" }));
    expect(out.logoApplied).toBe(false);
  });

  test("defaults ffmpegPath to ffmpeg-static when omitted", async () => {
    const compositor = new CanvasFfmpegVideoCompositor({ spawn: fakeFfmpeg({}) });
    if (!ffmpegStatic) {
      await expect(compositor.compositeVideo(videoRequest())).rejects.toThrow(/ffmpeg-static binary is not available/);
      return;
    }
    const out = await compositor.compositeVideo(videoRequest({ sampleAt: [] }));
    expect(out.video.byteLength).toBeGreaterThan(0);
  });

  test("limits overlapping encodes to MAX_CONCURRENT_ENCODES", async () => {
    let active = 0;
    let maxActive = 0;
    const spawn: FfmpegSpawn = () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const inner = fakeFfmpeg({ delayMs: 80 })("/opt/ffmpeg", [], {});
      inner.once("close", () => {
        active -= 1;
      });
      return inner;
    };
    const compositor = new CanvasFfmpegVideoCompositor({ spawn, ffmpegPath: "/opt/ffmpeg" });
    await Promise.all([
      compositor.compositeVideo(videoRequest()),
      compositor.compositeVideo(videoRequest()),
      compositor.compositeVideo(videoRequest()),
    ]);
    expect(MAX_CONCURRENT_ENCODES).toBe(2);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxActive).toBe(2);
  });
});
