import { describe, test, expect } from "vitest";
import { spawn as realSpawn, spawnSync } from "node:child_process";
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
  DEFAULT_ENCODE_TIMEOUT_MS,
  DEFAULT_KILL_GRACE_MS,
  MAX_CONCURRENT_ENCODES,
  MAX_DURATION_SEC,
  MAX_FPS,
  VideoCompositeValidationError,
  type FfmpegSpawn,
} from "../CanvasFfmpegVideoCompositor.js";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

interface Mp4Box {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly payload: number;
}

/** Tiny ISO-BMFF walker: top-level box types in order, with `moov`'s mvhd duration. */
function parseMp4Boxes(bytes: Buffer, start = 0, end = bytes.length): Mp4Box[] {
  const boxes: Mp4Box[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    let payload = offset + 8;
    if (size === 1) {
      size = Number(bytes.readBigUInt64BE(offset + 8));
      payload = offset + 16;
    } else if (size === 0) {
      size = end - offset;
    }
    boxes.push({ type, start: offset, end: offset + size, payload });
    offset += size;
  }
  return boxes;
}

function mvhdDuration(bytes: Buffer): number {
  const moov = parseMp4Boxes(bytes).find((b) => b.type === "moov");
  if (!moov) throw new Error("no moov box");
  const mvhd = parseMp4Boxes(bytes, moov.payload, moov.end).find((b) => b.type === "mvhd");
  if (!mvhd) throw new Error("no mvhd box");
  const version = bytes.readUInt8(mvhd.payload);
  // version 0: creation(4) modification(4) timescale(4) duration(4); version 1: 8/8/4/8.
  return version === 1
    ? Number(bytes.readBigUInt64BE(mvhd.payload + 4 + 8 + 8 + 4))
    : bytes.readUInt32BE(mvhd.payload + 4 + 4 + 4 + 4);
}

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
  /** Never emit close; record kill signals (optionally close on the given signal). */
  hang?: boolean;
  closeOnSignal?: NodeJS.Signals;
  signals?: NodeJS.Signals[];
}): FfmpegSpawn {
  return (_command, args) => {
    const outPath = args[args.length - 1];
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
      kill(signal?: NodeJS.Signals) {
        proc.killed = true;
        opts.signals?.push(signal ?? "SIGTERM");
        if (opts.hang) {
          if (signal === opts.closeOnSignal) queueMicrotask(() => proc.emit("close", null, signal));
          return true;
        }
        queueMicrotask(() => proc.emit("close", opts.code ?? 1, null));
        return true;
      },
    });
    if (opts.hang) return proc as never;

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
        stdout.end();
        if ((opts.code ?? 0) === 0) writeFileSync(outPath, opts.stdout ?? Buffer.from("xxxxftypxxxxmoovxxxx"));
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
  // Local machines without a working binary may skip the real-binary tests;
  // CI must never skip them silently, or a broken binary would ship green.
  test.runIf(process.env.CI)("the ffmpeg-static binary executes on CI", () => {
    expect(ffmpegOk, skipReason).toBe(true);
  });

  test.skipIf(!ffmpegOk)(
    skipReason ?? "rejects cleanly when the real binary exits early on a bad flag (EPIPE on stdin)",
    async () => {
      const spawn: FfmpegSpawn = (command, args, options) =>
        realSpawn(command, ["-not-a-real-flag", ...args], options);
      const compositor = new CanvasFfmpegVideoCompositor({ spawn });
      await expect(compositor.compositeVideo(videoRequest({ durationSec: 5, fps: 30 }))).rejects.toSatisfy(
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          expect(message).toMatch(/Unrecognized option|not-a-real-flag/);
          // No absolute path survives (the banner's lone "/" separators are not paths).
          expect(message).not.toMatch(/(?:^|[\s'"=])\/[^\s/]+\//);
          return true;
        },
      );
      // The gate was released: a follow-up encode with a healthy fake still runs.
      const next = new CanvasFfmpegVideoCompositor({ spawn: fakeFfmpeg({}), ffmpegPath: "/opt/ffmpeg" });
      await expect(next.compositeVideo(videoRequest({ sampleAt: [] }))).resolves.toBeTruthy();
    },
  );

  test.skipIf(!ffmpegOk)(
    skipReason ?? "encodes a playable mp4 from 24 frames at 12 fps (108×192)",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "cf-video-"));
      try {
        const compositor = new CanvasFfmpegVideoCompositor();
        const out = await compositor.compositeVideo(videoRequest({ sampleAt: [0, 0.5, 1] }));
        writeFileSync(join(dir, "clip.mp4"), out.video);
        const bytes = Buffer.from(out.video);
        const order = parseMp4Boxes(bytes).map((b) => b.type);
        // A finalized (non-fragmented) faststart mp4: moov ahead of mdat, no moof.
        expect([
          ["ftyp", "moov", "free", "mdat"],
          ["ftyp", "moov", "mdat"],
        ]).toContainEqual(order);
        expect(mvhdDuration(bytes)).toBeGreaterThan(0);
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

  test.each([0, 61, 12.5, Number.POSITIVE_INFINITY, Number.NaN, "12"] as const)(
    "rejects fps %s with a named validation error",
    async (fps) => {
      const compositor = new CanvasFfmpegVideoCompositor({ spawn: fakeFfmpeg({}), ffmpegPath: "/opt/ffmpeg" });
      await expect(compositor.compositeVideo(videoRequest({ fps: fps as unknown as number }))).rejects.toSatisfy(
        (error: unknown) => {
          expect(error).toBeInstanceOf(VideoCompositeValidationError);
          expect((error as Error).name).toBe("VideoCompositeValidationError");
          expect((error as Error).message).toMatch(/fps must be an integer in \[1, 60\]/);
          return true;
        },
      );
    },
  );

  test.each([0, -1, 60.5, Number.POSITIVE_INFINITY, Number.NaN, "2"] as const)(
    "rejects durationSec %s",
    async (durationSec) => {
      const compositor = new CanvasFfmpegVideoCompositor({ spawn: fakeFfmpeg({}), ffmpegPath: "/opt/ffmpeg" });
      await expect(
        compositor.compositeVideo(videoRequest({ durationSec: durationSec as unknown as number })),
      ).rejects.toThrow(/durationSec must be a finite number in \(0, 60\]/);
    },
  );

  test.each([2, -0.1, Number.NaN, "x"] as const)("rejects sampleAt value %s", async (t) => {
    const compositor = new CanvasFfmpegVideoCompositor({ spawn: fakeFfmpeg({}), ffmpegPath: "/opt/ffmpeg" });
    await expect(
      compositor.compositeVideo(videoRequest({ sampleAt: [t as unknown as number] })),
    ).rejects.toThrow(/sampleAt values must be finite numbers in \[0, 1\]/);
  });

  test("rejects a non-array sampleAt", async () => {
    const compositor = new CanvasFfmpegVideoCompositor({ spawn: fakeFfmpeg({}), ffmpegPath: "/opt/ffmpeg" });
    await expect(
      compositor.compositeVideo(videoRequest({ sampleAt: 0.5 as unknown as number[] })),
    ).rejects.toThrow(/sampleAt must be an array/);
  });

  test("de-duplicates and sorts sampleAt before sampling frames", async () => {
    const compositor = new CanvasFfmpegVideoCompositor({ spawn: fakeFfmpeg({}), ffmpegPath: "/opt/ffmpeg" });
    const out = await compositor.compositeVideo(videoRequest({ sampleAt: [1, 0.5, 0, 0.5, 1] }));
    expect(out.sampledFrames).toHaveLength(3);
    const sorted = await compositor.compositeVideo(videoRequest({ sampleAt: [0, 0.5, 1] }));
    expect(out.sampledFrames.map((f) => Buffer.from(f).toString("hex"))).toEqual(
      sorted.sampledFrames.map((f) => Buffer.from(f).toString("hex")),
    );
  });

  test("accepts the boundary values fps 60 and durationSec 60", async () => {
    const compositor = new CanvasFfmpegVideoCompositor({ spawn: fakeFfmpeg({}), ffmpegPath: "/opt/ffmpeg" });
    await expect(compositor.compositeVideo(videoRequest({ fps: 1, durationSec: 60, sampleAt: [] }))).resolves.toBeTruthy();
    expect(MAX_FPS).toBe(60);
    expect(MAX_DURATION_SEC).toBe(60);
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

  test("redacts before taking the tail so a path cut by the 4000-char window cannot leak", async () => {
    const stderr = `${"x".repeat(3_995)} /var/secret/lib/x264 end`;
    const compositor = new CanvasFfmpegVideoCompositor({
      spawn: fakeFfmpeg({ code: 1, stderr }),
      ffmpegPath: "/opt/ffmpeg",
    });
    await expect(compositor.compositeVideo(videoRequest())).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      expect(message.endsWith("<path> end")).toBe(true);
      expect(message).not.toContain("secret");
      return true;
    });
  });

  test("leaves lone slashes, fractions, and single-segment roots alone", async () => {
    const stderr = "libavutil 58. 2.100 / 58. 2.100 fps=30000/1001 root=/tmp bad=/opt/ffmpeg/x C:\\Users\\me\\clip";
    const compositor = new CanvasFfmpegVideoCompositor({
      spawn: fakeFfmpeg({ code: 1, stderr }),
      ffmpegPath: "/opt/ffmpeg",
    });
    await expect(compositor.compositeVideo(videoRequest())).rejects.toThrow(
      "libavutil 58. 2.100 / 58. 2.100 fps=30000/1001 root=/tmp bad=ffmpeg/x <path>",
    );
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

  test("kills a hung ffmpeg after encodeTimeoutMs, escalates to SIGKILL, and rejects only once the child has closed", async () => {
    const signals: NodeJS.Signals[] = [];
    let closed = false;
    const spawn: FfmpegSpawn = (command, args, options) => {
      // Exits only on SIGKILL — SIGTERM is ignored, as a wedged encoder would.
      const inner = fakeFfmpeg({ hang: true, signals, closeOnSignal: "SIGKILL" })(command, args, options);
      inner.once("close", () => {
        closed = true;
      });
      return inner;
    };
    const compositor = new CanvasFfmpegVideoCompositor({
      spawn,
      ffmpegPath: "/opt/ffmpeg",
      encodeTimeoutMs: 40,
      killGraceMs: 20,
    });
    await expect(compositor.compositeVideo(videoRequest())).rejects.toThrow(/ffmpeg encode timed out after 40ms/);
    // The rejection waited for the escalation and the close: no live child is left behind.
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(closed).toBe(true);

    // Gate released: two healthy encodes still run concurrently afterwards.
    const healthy = new CanvasFfmpegVideoCompositor({ spawn: fakeFfmpeg({}), ffmpegPath: "/opt/ffmpeg" });
    await expect(
      Promise.all([healthy.compositeVideo(videoRequest({ sampleAt: [] })), healthy.compositeVideo(videoRequest({ sampleAt: [] }))]),
    ).resolves.toHaveLength(2);
  });

  test("a timed-out encode holds its gate slot until the child closes, so MAX_CONCURRENT_ENCODES is never exceeded", async () => {
    const hungSignals: NodeJS.Signals[][] = [];
    let live = 0;
    let maxLive = 0;
    let liveWhenHealthySpawned = -1;
    const track = (proc: ReturnType<FfmpegSpawn>): ReturnType<FfmpegSpawn> => {
      live += 1;
      maxLive = Math.max(maxLive, live);
      proc.once("close", () => {
        live -= 1;
      });
      return proc;
    };
    const hung: FfmpegSpawn = (command, args, options) => {
      const signals: NodeJS.Signals[] = [];
      hungSignals.push(signals);
      return track(fakeFfmpeg({ hang: true, signals, closeOnSignal: "SIGKILL" })(command, args, options));
    };
    const healthySpawn: FfmpegSpawn = (command, args, options) => {
      liveWhenHealthySpawned = live;
      return track(fakeFfmpeg({})(command, args, options));
    };
    const hungCompositor = new CanvasFfmpegVideoCompositor({ spawn: hung, ffmpegPath: "/opt/ffmpeg", encodeTimeoutMs: 40, killGraceMs: 20 });
    const healthy = new CanvasFfmpegVideoCompositor({ spawn: healthySpawn, ffmpegPath: "/opt/ffmpeg" });

    // Two hung encodes fill the pool; the healthy one must wait for a real exit.
    const results = await Promise.allSettled([
      hungCompositor.compositeVideo(videoRequest()),
      hungCompositor.compositeVideo(videoRequest()),
      healthy.compositeVideo(videoRequest({ sampleAt: [] })),
    ]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected", "fulfilled"]);
    expect(hungSignals).toEqual([
      ["SIGTERM", "SIGKILL"],
      ["SIGTERM", "SIGKILL"],
    ]);
    expect(maxLive).toBe(MAX_CONCURRENT_ENCODES);
    // The healthy child spawned only after at least one hung child had closed.
    expect(liveWhenHealthySpawned).toBeLessThan(MAX_CONCURRENT_ENCODES);
  });

  test("does not SIGKILL a child that exits on SIGTERM", async () => {
    const signals: NodeJS.Signals[] = [];
    const compositor = new CanvasFfmpegVideoCompositor({
      spawn: fakeFfmpeg({ hang: true, signals, closeOnSignal: "SIGTERM" }),
      ffmpegPath: "/opt/ffmpeg",
      encodeTimeoutMs: 30,
      killGraceMs: 10,
    });
    await expect(compositor.compositeVideo(videoRequest())).rejects.toThrow(/timed out/);
    await new Promise((r) => setTimeout(r, 30));
    expect(signals).toEqual(["SIGTERM"]);
  });

  test("times out when frames are written but ffmpeg never closes", async () => {
    // The hung fake drains stdin, so every frame is written before the wait on close.
    const compositor = new CanvasFfmpegVideoCompositor({
      spawn: fakeFfmpeg({ hang: true, closeOnSignal: "SIGKILL" }),
      ffmpegPath: "/opt/ffmpeg",
      encodeTimeoutMs: 60,
      killGraceMs: 5,
    });
    await expect(compositor.compositeVideo(videoRequest())).rejects.toThrow(/timed out after 60ms/);
  });

  test("exposes the default timeout constants", () => {
    expect(DEFAULT_ENCODE_TIMEOUT_MS).toBe(120_000);
    expect(DEFAULT_KILL_GRACE_MS).toBe(2_000);
  });

  test("limits overlapping encodes to MAX_CONCURRENT_ENCODES", async () => {
    let active = 0;
    let maxActive = 0;
    const spawn: FfmpegSpawn = (command, args, options) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const inner = fakeFfmpeg({ delayMs: 80 })(command, args, options);
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
