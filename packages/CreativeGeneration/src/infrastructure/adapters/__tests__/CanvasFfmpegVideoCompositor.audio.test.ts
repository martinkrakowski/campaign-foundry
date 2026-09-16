import { describe, test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { createCanvas } from "@napi-rs/canvas";
import type { VideoCompositeRequest } from "@campaignfoundry/CampaignOrchestration";
import {
  AAC_FRAME_TOLERANCE_SEC,
  AUDIO_CHANNELS,
  AUDIO_SAMPLE_RATE,
  CanvasFfmpegVideoCompositor,
  type FfmpegSpawn,
} from "../CanvasFfmpegVideoCompositor.js";

/**
 * VE3b1 — the music bed in the encoder.
 *
 * "Args" below pins the encoder's argv through a fake spawn (no real ffmpeg
 * needed): without `audio`, the array is exactly today's (VE-D3, and the
 * manifest's mutation (b) — always adding the audio input — must break this
 * exact-array assertion). With `audio`, the second input, explicit maps and
 * `-c:a aac` appear, and `<outPath>` stays last.
 *
 * "Real ffmpeg" below runs the actual pinned binary: one AAC + one h264
 * stream, and determinism across two runs. Duration is measured by decoding
 * the AUDIO STREAM ITSELF to raw PCM and dividing by its byte rate
 * (`probeAudioStreamDurationSec`) — never the container-level `Duration:`
 * line `ffmpeg -i` prints, which reflects the *longest* track (the video,
 * always `frames / fps`) and would read back the requested length even if
 * the audio track were short or silent. Manifest mutation (a) — dropping the
 * duration cut — and (c) — dropping the pad — must each break their own
 * audio-stream duration assertion here.
 */

const require = createRequire(import.meta.url);
const ffmpegStatic = require("ffmpeg-static") as string | null;
const ffmpegPath = typeof ffmpegStatic === "string" ? ffmpegStatic : null;
const ffmpegProbe = ffmpegPath
  ? spawnSync(ffmpegPath, ["-version"], { encoding: "utf8", timeout: 5_000 })
  : undefined;
const ffmpegOk = ffmpegProbe?.status === 0;
const skipReason = ffmpegOk
  ? undefined
  : `ffmpeg-static binary cannot execute${ffmpegProbe?.error ? ` (${ffmpegProbe.error.message})` : ffmpegProbe ? ` (exited ${ffmpegProbe.status})` : " (path is null)"}`;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const WIDTH = 108;
const HEIGHT = 192;

const background = (): Uint8Array => {
  const c = createCanvas(WIDTH, HEIGHT);
  c.getContext("2d").fillRect(0, 0, WIDTH, HEIGHT);
  return c.toBuffer("image/png");
};

const videoRequest = (over: Partial<VideoCompositeRequest> = {}): VideoCompositeRequest => ({
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
  ...over,
});

/** Records every spawned argv, then behaves exactly like a healthy ffmpeg. */
function argCapturingFfmpeg(captured: string[][]): FfmpegSpawn {
  return (_command, args) => {
    captured.push([...args]);
    const outPath = args[args.length - 1];
    const stdin = new PassThrough({ highWaterMark: 1024 * 1024 });
    stdin.resume();
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
}

describe("CanvasFfmpegVideoCompositor — audio args (VE3b1)", () => {
  test("without audio, the argv is exactly today's array", async () => {
    const captured: string[][] = [];
    const compositor = new CanvasFfmpegVideoCompositor({
      spawn: argCapturingFfmpeg(captured),
      ffmpegPath: "/opt/ffmpeg",
    });
    await compositor.compositeVideo(videoRequest());

    expect(captured).toHaveLength(1);
    const args = captured[0];
    const outPath = args[args.length - 1];
    expect(outPath).toMatch(/out\.mp4$/);
    expect(args.slice(0, -1)).toEqual([
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "-s",
      `${WIDTH}x${HEIGHT}`,
      "-framerate",
      "12",
      "-i",
      "-",
      "-sws_flags",
      "+accurate_rnd+bitexact",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-threads",
      "1",
      "-movflags",
      "+faststart",
      "-flags",
      "+bitexact",
      "-fflags",
      "+bitexact",
      "-map_metadata",
      "-1",
      "-f",
      "mp4",
      "-y",
    ]);
  });

  test("with audio, a second input, explicit maps and -c:a aac appear, and <outPath> stays last", async () => {
    const captured: string[][] = [];
    const compositor = new CanvasFfmpegVideoCompositor({
      spawn: argCapturingFfmpeg(captured),
      ffmpegPath: "/opt/ffmpeg",
    });
    const audio = new Uint8Array([1, 2, 3, 4]); // spawn is faked — never decoded here.
    await compositor.compositeVideo(videoRequest({ audio }));

    const args = captured[0];
    const outPath = args[args.length - 1];
    expect(outPath).toMatch(/out\.mp4$/);

    const iIndices = args.reduce<number[]>((acc, v, i) => (v === "-i" ? [...acc, i] : acc), []);
    expect(iIndices).toHaveLength(2);
    expect(args[iIndices[0] + 1]).toBe("-"); // the video pipe stays first
    const bedPath = args[iIndices[1] + 1];
    expect(bedPath).not.toBe("-");
    expect(bedPath).not.toBe(outPath);
    expect(dirname(bedPath)).toBe(dirname(outPath)); // same encode workDir

    // -sws_flags must sit after BOTH -i's (VE3b1's doc comment: between them is inert).
    const swsIndex = args.indexOf("-sws_flags");
    expect(swsIndex).toBeGreaterThan(iIndices[1]);

    expect(args).toEqual(
      expect.arrayContaining(["-map", "0:v", "-map", "1:a:0", "-c:a", "aac", "-b:a", "128k"]),
    );
    // `1:a:0`, never a bare `1:a` — a bare form maps EVERY audio stream in the
    // bed's container (alternate languages, a commentary track), breaking the
    // lane's "exactly one AAC track" acceptance criterion (see the real-ffmpeg
    // two-audio-stream test below).
    expect(args).not.toContain("1:a");
    // The map pair for video precedes the one for audio.
    const mapVIndex = args.indexOf("0:v");
    const mapAIndex = args.indexOf("1:a:0");
    expect(mapVIndex).toBeGreaterThan(-1);
    expect(mapAIndex).toBeGreaterThan(mapVIndex);
  });

  test("a bed exactly at the encoded video's duration still cuts and fades (no negative fade start)", async () => {
    const captured: string[][] = [];
    const compositor = new CanvasFfmpegVideoCompositor({
      spawn: argCapturingFfmpeg(captured),
      ffmpegPath: "/opt/ffmpeg",
    });
    // fps 10 * durationSec 0.2 = 2 frames exactly, so frames / fps = 0.2 exactly
    // (no floating-point noise) and the fade is clamped to the full 0.2s.
    await compositor.compositeVideo(videoRequest({ audio: new Uint8Array([9]), durationSec: 0.2, fps: 10 }));
    const af = captured[0][captured[0].indexOf("-af") + 1];
    expect(af).toBe("apad,atrim=end=0.2,afade=t=out:st=0:d=0.2");
  });

  test("trims and fades to the encoded video's rounded duration, not the unrounded durationSec", async () => {
    const captured: string[][] = [];
    const compositor = new CanvasFfmpegVideoCompositor({
      spawn: argCapturingFfmpeg(captured),
      ffmpegPath: "/opt/ffmpeg",
    });
    // durationSec 1.5 * fps 1 = 1.5, which rounds UP to 2 frames — so the
    // encoded video is 2s long, not 1.5s, and the audio must match the 2s it
    // is actually muxed against, not the request's unrounded field.
    await compositor.compositeVideo(videoRequest({ audio: new Uint8Array([9]), durationSec: 1.5, fps: 1 }));
    const af = captured[0][captured[0].indexOf("-af") + 1];
    expect(af).toBe("apad,atrim=end=2,afade=t=out:st=1.75:d=0.25");
  });
});

/** Deterministic — no randomness, no clock. Sine bed generated by the pinned binary itself. */
function generateSineBedWav(ffmpeg: string, durationSec: number): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "cf-audio-fixture-"));
  try {
    const outPath = join(dir, "bed.wav");
    const result = spawnSync(
      ffmpeg,
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=440:sample_rate=${AUDIO_SAMPLE_RATE}:duration=${durationSec}`,
        "-c:a",
        "pcm_s16le",
        "-f",
        "wav",
        outPath,
      ],
      { timeout: 10_000 },
    );
    if (result.status !== 0) {
      throw new Error(`sine bed generation failed (exit ${String(result.status)}): ${result.stderr?.toString()}`);
    }
    return new Uint8Array(readFileSync(outPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A container with TWO audio streams (two different sine tones), matroska — self-describing, so ffmpeg still probes it by content alone. */
function generateTwoStreamBed(ffmpeg: string, durationSec: number): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "cf-audio-fixture-"));
  try {
    const outPath = join(dir, "bed.mkv");
    const result = spawnSync(
      ffmpeg,
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=440:sample_rate=${AUDIO_SAMPLE_RATE}:duration=${durationSec}`,
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=880:sample_rate=${AUDIO_SAMPLE_RATE}:duration=${durationSec}`,
        "-map",
        "0:a",
        "-map",
        "1:a",
        "-c:a",
        "pcm_s16le",
        "-f",
        "matroska",
        outPath,
      ],
      { timeout: 10_000 },
    );
    if (result.status !== 0) {
      throw new Error(`two-stream bed generation failed (exit ${String(result.status)}): ${result.stderr?.toString()}`);
    }
    return new Uint8Array(readFileSync(outPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PCM_BYTES_PER_SAMPLE = 2; // s16le

/**
 * The AUDIO STREAM's own decoded duration — never the container-level
 * `Duration:` line `ffmpeg -i` prints. That line reflects the *longest*
 * track (mp4's own top-level duration), and the video track is always
 * `frames / fps` regardless of what the audio track actually contains: a
 * short/silent/missing audio stream would still read back the video's full
 * length, so a container-duration assertion cannot tell "the encoder padded
 * the bed" from "the encoder dropped `apad` and left a short track" — the
 * finding this rewrite fixes. Decoding to raw PCM and dividing by the byte
 * rate is exact (no periodic-progress-line rounding), the same "measure with
 * the pinned binary itself, no ffprobe" precedent the byte golden already
 * uses for its own stream.
 */
function probeAudioStreamDurationSec(ffmpeg: string, filePath: string): number {
  const dir = mkdtempSync(join(tmpdir(), "cf-audio-probe-"));
  try {
    const pcmPath = join(dir, "audio.pcm");
    const result = spawnSync(
      ffmpeg,
      [
        "-y",
        "-i",
        filePath,
        "-map",
        "0:a:0",
        "-f",
        "s16le",
        "-acodec",
        "pcm_s16le",
        "-ar",
        String(AUDIO_SAMPLE_RATE),
        "-ac",
        String(AUDIO_CHANNELS),
        pcmPath,
      ],
      { timeout: 10_000 },
    );
    if (result.status !== 0) {
      throw new Error(`audio stream decode failed (exit ${String(result.status)}): ${result.stderr?.toString().slice(-2000)}`);
    }
    const bytes = statSync(pcmPath).size;
    return bytes / (AUDIO_SAMPLE_RATE * AUDIO_CHANNELS * PCM_BYTES_PER_SAMPLE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function countStreams(ffmpeg: string, filePath: string): { readonly video: number; readonly audio: number } {
  const result = spawnSync(ffmpeg, ["-i", filePath], { encoding: "utf8", timeout: 10_000 });
  const stderr = result.stderr ?? "";
  const video = (stderr.match(/Stream #\d+:\d+.*: Video:/g) ?? []).length;
  const audio = (stderr.match(/Stream #\d+:\d+.*: Audio:/g) ?? []).length;
  return { video, audio };
}

describe("CanvasFfmpegVideoCompositor — audio, real ffmpeg (VE3b1)", () => {
  test.runIf(process.env.CI)("the ffmpeg-static binary executes on CI", () => {
    expect(ffmpegOk, skipReason).toBe(true);
  });

  test.skipIf(!ffmpegOk)(
    skipReason ?? "output has exactly one AAC stream and one h264 stream",
    { timeout: 30_000 },
    async () => {
      if (!ffmpegPath) throw new Error("ffmpeg-static binary is not available");
      const audio = generateSineBedWav(ffmpegPath, 2);
      const compositor = new CanvasFfmpegVideoCompositor();
      const { video } = await compositor.compositeVideo(videoRequest({ audio }));

      const dir = mkdtempSync(join(tmpdir(), "cf-audio-out-"));
      try {
        const outPath = join(dir, "out.mp4");
        writeFileSync(outPath, Buffer.from(video));
        const counts = countStreams(ffmpegPath, outPath);
        expect(counts).toEqual({ video: 1, audio: 1 });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!ffmpegOk)(
    skipReason ??
      "a bed shorter than the video: the AUDIO STREAM ITSELF is padded to durationSec within the AAC frame tolerance",
    { timeout: 30_000 },
    async () => {
      if (!ffmpegPath) throw new Error("ffmpeg-static binary is not available");
      const durationSec = 2;
      const audio = generateSineBedWav(ffmpegPath, 0.5); // shorter than the video
      const compositor = new CanvasFfmpegVideoCompositor();
      const { video } = await compositor.compositeVideo(videoRequest({ audio, durationSec }));

      const dir = mkdtempSync(join(tmpdir(), "cf-audio-out-"));
      try {
        const outPath = join(dir, "out.mp4");
        writeFileSync(outPath, Buffer.from(video));
        const duration = probeAudioStreamDurationSec(ffmpegPath, outPath);
        expect(Math.abs(duration - durationSec)).toBeLessThanOrEqual(AAC_FRAME_TOLERANCE_SEC);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!ffmpegOk)(
    skipReason ??
      "a bed longer than the video: the AUDIO STREAM ITSELF is cut to durationSec within the AAC frame tolerance",
    { timeout: 30_000 },
    async () => {
      if (!ffmpegPath) throw new Error("ffmpeg-static binary is not available");
      const durationSec = 2;
      const audio = generateSineBedWav(ffmpegPath, 4); // longer than the video
      const compositor = new CanvasFfmpegVideoCompositor();
      const { video } = await compositor.compositeVideo(videoRequest({ audio, durationSec }));

      const dir = mkdtempSync(join(tmpdir(), "cf-audio-out-"));
      try {
        const outPath = join(dir, "out.mp4");
        writeFileSync(outPath, Buffer.from(video));
        const duration = probeAudioStreamDurationSec(ffmpegPath, outPath);
        expect(Math.abs(duration - durationSec)).toBeLessThanOrEqual(AAC_FRAME_TOLERANCE_SEC);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!ffmpegOk)(
    skipReason ?? "encoding the same bed twice in one process yields byte-identical MP4s",
    { timeout: 30_000 },
    async () => {
      if (!ffmpegPath) throw new Error("ffmpeg-static binary is not available");
      const audio = generateSineBedWav(ffmpegPath, 3);
      const compositor = new CanvasFfmpegVideoCompositor();
      const first = await compositor.compositeVideo(videoRequest({ audio }));
      const second = await compositor.compositeVideo(videoRequest({ audio }));
      expect(sha256(second.video)).toBe(sha256(first.video));
      expect(Buffer.from(second.video).equals(Buffer.from(first.video))).toBe(true);
    },
  );

  test.skipIf(!ffmpegOk)(
    skipReason ?? "a bed with two audio streams still yields exactly one audio stream in the output",
    { timeout: 30_000 },
    async () => {
      if (!ffmpegPath) throw new Error("ffmpeg-static binary is not available");
      const audio = generateTwoStreamBed(ffmpegPath, 2);
      const compositor = new CanvasFfmpegVideoCompositor();
      const { video } = await compositor.compositeVideo(videoRequest({ audio }));

      const dir = mkdtempSync(join(tmpdir(), "cf-audio-out-"));
      try {
        const outPath = join(dir, "out.mp4");
        writeFileSync(outPath, Buffer.from(video));
        const counts = countStreams(ffmpegPath, outPath);
        expect(counts).toEqual({ video: 1, audio: 1 });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!ffmpegOk)(
    skipReason ??
      "when durationSec * fps rounds unevenly, the AUDIO STREAM ITSELF matches the encoded video's actual duration",
    { timeout: 30_000 },
    async () => {
      if (!ffmpegPath) throw new Error("ffmpeg-static binary is not available");
      // fps 1 * durationSec 1.5 rounds to 2 frames = 2s of encoded video.
      const durationSec = 1.5;
      const fps = 1;
      const encodedDurationSec = 2;
      const audio = generateSineBedWav(ffmpegPath, 1); // shorter than either duration — exercises padding too
      const compositor = new CanvasFfmpegVideoCompositor();
      const { video } = await compositor.compositeVideo(videoRequest({ audio, durationSec, fps }));

      const dir = mkdtempSync(join(tmpdir(), "cf-audio-out-"));
      try {
        const outPath = join(dir, "out.mp4");
        writeFileSync(outPath, Buffer.from(video));
        const duration = probeAudioStreamDurationSec(ffmpegPath, outPath);
        expect(Math.abs(duration - encodedDurationSec)).toBeLessThanOrEqual(AAC_FRAME_TOLERANCE_SEC);
        // Confirms the assertion is actually discriminating: the unrounded
        // durationSec is a full frame-tolerance away from what was measured.
        expect(Math.abs(duration - durationSec)).toBeGreaterThan(AAC_FRAME_TOLERANCE_SEC);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
