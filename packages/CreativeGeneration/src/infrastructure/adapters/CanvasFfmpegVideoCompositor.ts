import { spawn as defaultSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { createCanvas, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";
import type { VideoCompositeRequest, VideoCompositeResult, VideoCompositorPort } from "@campaignfoundry/CampaignOrchestration";
import { restT } from "@campaignfoundry/CampaignOrchestration";
import type { CopyTimeline, ResolvedBeat } from "@campaignfoundry/CampaignOrchestration";
// Static import (not createRequire) so bundlers such as Nitro trace the package
// and its binary into the production output.
import ffmpegStatic from "ffmpeg-static";
import { NodeCanvasCompositor } from "./NodeCanvasCompositor.js";

/** Encode pool size — canvas raster is the bottleneck, not ffmpeg. */
export const MAX_CONCURRENT_ENCODES = 2;
/** Wall-clock budget for one encode before the child is killed. */
export const DEFAULT_ENCODE_TIMEOUT_MS = 120_000;
/** Grace after SIGTERM before escalating to SIGKILL. */
export const DEFAULT_KILL_GRACE_MS = 2_000;

export type FfmpegSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface CanvasFfmpegVideoCompositorOptions {
  readonly fontFamily?: string;
  readonly spawn?: FfmpegSpawn;
  readonly ffmpegPath?: string | null;
  /** Kill the encode and reject after this many ms (default {@link DEFAULT_ENCODE_TIMEOUT_MS}). */
  readonly encodeTimeoutMs?: number;
  /** SIGTERM → SIGKILL escalation delay (default {@link DEFAULT_KILL_GRACE_MS}). */
  readonly killGraceMs?: number;
}

type Prepared = Awaited<ReturnType<typeof NodeCanvasCompositor.prepare>>;

class EncodeGate {
  #active = 0;
  #waiters: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (this.#active < MAX_CONCURRENT_ENCODES) {
      this.#active += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.#waiters.push(() => {
        this.#active += 1;
        resolve();
      });
    });
  }

  release(): void {
    this.#active -= 1;
    const next = this.#waiters.shift();
    if (next) next();
  }
}

const encodeGate = new EncodeGate();
const STDERR_TAIL = 4_000;

/**
 * CanvasFfmpegVideoCompositor — VideoCompositorPort adapter.
 *
 * Prepares the still once, blits each frame through {@link NodeCanvasCompositor.draw},
 * and pipes packed RGBA into the `ffmpeg-static` binary (never system ffmpeg).
 */
export class CanvasFfmpegVideoCompositor implements VideoCompositorPort {
  private readonly fontFamily: string;
  private readonly spawn: FfmpegSpawn;
  private readonly ffmpegPath: string | null;
  private readonly encodeTimeoutMs: number;
  private readonly killGraceMs: number;

  constructor(options: CanvasFfmpegVideoCompositorOptions = {}) {
    this.fontFamily = options.fontFamily ?? "Inter";
    this.spawn =
      options.spawn ??
      ((command, args, spawnOptions) => defaultSpawn(command, [...args], spawnOptions));
    this.ffmpegPath = options.ffmpegPath !== undefined ? options.ffmpegPath : ffmpegStatic;
    this.encodeTimeoutMs = options.encodeTimeoutMs ?? DEFAULT_ENCODE_TIMEOUT_MS;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  }

  async compositeVideo(request: VideoCompositeRequest): Promise<VideoCompositeResult> {
    const sampleAt = validateRequest(request);
    const frames = Math.round(request.durationSec * request.fps);
    if (frames < 2) {
      throw new VideoCompositeValidationError("durationSec * fps must yield at least 2 frames");
    }
    if (!this.ffmpegPath) {
      throw new Error("ffmpeg-static binary is not available");
    }

    const prepared = await NodeCanvasCompositor.prepare(request, this.fontFamily);
    const canvas = createCanvas(prepared.width, prepared.height);
    const ctx = canvas.getContext("2d");

    const video = await this.encodeFrames(canvas, ctx, prepared, request, frames, this.ffmpegPath);

    // Poster = the key beat at rest (D7): the pose clock settles at restT(kind)
    // while the copy clock sits on the key beat's own mid-window, so the poster
    // shows exactly what buyers see when the campaign middle beat is prominent.
    // The effect clock is settled independently (1, H4): ken-burns-out rests
    // at t = 0, which is the effect's full entrance — not the still we deliver.
    NodeCanvasCompositor.draw(
      ctx,
      prepared,
      restT(request.motion),
      request.motion,
      posterCopyTAt(request.timeline, prepared.timeline),
      1,
    );
    const poster = new Uint8Array(canvas.toBuffer("image/png"));

    const sampledFrames = sampleAt.map((t) => {
      // Frames clip the live sequence: only `t` moves, so copy follows pose in
      // lockstep and the poster/timeline clocks stay independent (D2/D7).
      NodeCanvasCompositor.draw(ctx, prepared, t, request.motion);
      return new Uint8Array(canvas.toBuffer("image/png"));
    });

    return { video, poster, sampledFrames, logoApplied: prepared.logoApplied };
  }

  private async encodeFrames(
    canvas: Canvas,
    ctx: SKRSContext2D,
    prepared: Prepared,
    request: VideoCompositeRequest,
    frames: number,
    ffmpegPath: string,
  ): Promise<Uint8Array> {
    await encodeGate.acquire();
    // The mp4 muxer needs a seekable output to write a finalized `moov` with real
    // durations; on `pipe:1` it can only emit fragmented mp4 (`empty_moov`), which
    // players report as duration 0 and platform uploaders reject. Encode to a temp
    // file and read it back instead.
    const workDir = await mkdtemp(join(tmpdir(), "cf-encode-"));
    const outPath = join(workDir, "out.mp4");
    try {
      const child = this.spawn(ffmpegPath, ffmpegArgs(prepared.width, prepared.height, request.fps, outPath), {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      if (!child.stdin || !child.stdout || !child.stderr) {
        child.kill();
        throw new Error("ffmpeg stdio pipes were not created");
      }

      let stderr = "";
      child.stdout.resume(); // nothing is written to stdout; keep the pipe from filling

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        if (stderr.length > STDERR_TAIL * 2) stderr = stderr.slice(-STDERR_TAIL);
      });

      const finished = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code));
      });
      finished.catch(() => {}); // observed below via race; keep a late error from going unhandled

      // Wall-clock budget: SIGTERM at expiry, SIGKILL if the child is still around
      // after the grace period. The races below stop waiting on the write and the
      // exit code at expiry, so a hung ffmpeg (or a stdin that never drains) cannot
      // hold the gate forever — but the gate is released and the work dir removed
      // only once the child has actually closed (see `finally`), so no more than
      // MAX_CONCURRENT_ENCODES ffmpeg processes ever exist and a live encoder never
      // races the cleanup.
      const timeout = encodeTimeout(child, this.encodeTimeoutMs, this.killGraceMs);

      let writeError: unknown;
      try {
        await Promise.race([writeFrames(child.stdin, canvas, ctx, prepared, request, frames), timeout.promise]);
      } catch (error) {
        writeError = error;
        if (!child.killed) child.kill();
      }

      let code: number | null;
      try {
        code = await Promise.race([finished, timeout.promise]);
      } catch (error) {
        throw new Error(formatFfmpegFailure(error instanceof Error ? error.message : String(error), ffmpegPath));
      } finally {
        timeout.clear();
        // SIGTERM → SIGKILL guarantees the child exits; wait for that exit (a
        // spawn error has already settled `finished`) before the outer cleanup.
        await finished.catch(() => {});
      }

      if (code !== 0) {
        throw new Error(formatFfmpegFailure(stderr || `ffmpeg exited ${code}`, ffmpegPath));
      }
      if (writeError) {
        throw new Error(
          formatFfmpegFailure(writeError instanceof Error ? writeError.message : String(writeError), ffmpegPath),
        );
      }
      return new Uint8Array(await readFile(outPath));
    } finally {
      encodeGate.release();
      await rm(workDir, { recursive: true, force: true });
    }
  }
}

/**
 * The poster's copy clock (D7): the midpoint of the key beat's window, in copy
 * seconds. Undefined without `copy.timeline`, which keeps the poster on the
 * legacy path. The pose clock is unaffected — only this value is passed as the
 * compositor's `copyT`.
 */
function posterCopyTAt(
  timeline: CopyTimeline | undefined,
  resolved: readonly ResolvedBeat[] | undefined,
): number | undefined {
  if (timeline === undefined || resolved === undefined) return undefined;
  const keyBeat = resolved[timeline.keyBeat - 1];
  return (keyBeat.startT + keyBeat.endT) / 2;
}

function ffmpegArgs(width: number, height: number, fps: number, outPath: string): string[] {
  return [
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgba",
    "-s",
    `${width}x${height}`,
    "-framerate",
    String(fps),
    "-i",
    "-",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    // faststart moves the finalized moov ahead of mdat (progressive playback);
    // bitexact strips encoder tags so identical frames yield identical bytes.
    "-movflags",
    "+faststart",
    "-fflags",
    "+bitexact",
    "-map_metadata",
    "-1",
    "-f",
    "mp4",
    "-y",
    outPath,
  ];
}

async function writeFrames(
  stdin: Writable,
  canvas: Canvas,
  ctx: SKRSContext2D,
  prepared: Prepared,
  request: VideoCompositeRequest,
  frames: number,
): Promise<void> {
  for (let i = 0; i < frames; i++) {
    NodeCanvasCompositor.draw(ctx, prepared, i / (frames - 1), request.motion);
    await writeWithBackpressure(stdin, Buffer.from(canvas.data()));
  }
  stdin.end();
}

interface EncodeTimeout {
  readonly promise: Promise<never>;
  clear(): void;
}

function encodeTimeout(child: ChildProcess, timeoutMs: number, killGraceMs: number): EncodeTimeout {
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  child.once("close", () => clearTimeout(killTimer));
  let expire!: (error: Error) => void;
  const promise = new Promise<never>((_, reject) => {
    expire = reject;
  });
  promise.catch(() => {}); // raced twice; a stray rejection must not surface as unhandled
  const timer = setTimeout(() => {
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
    expire(new Error(`ffmpeg encode timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  return { promise, clear: () => clearTimeout(timer) };
}

async function writeWithBackpressure(stdin: Writable, data: Buffer): Promise<void> {
  if (!stdin.write(data)) {
    await once(stdin, "drain");
  }
}

/** Thrown for a request outside the adapter's contract; the message names the field. */
export class VideoCompositeValidationError extends Error {
  override readonly name = "VideoCompositeValidationError";
}

export const MAX_FPS = 60;
export const MAX_DURATION_SEC = 60;

/** Validate fps / durationSec / sampleAt; returns sampleAt de-duplicated and sorted ascending. */
function validateRequest(request: VideoCompositeRequest): readonly number[] {
  const { fps, durationSec, sampleAt } = request;
  if (!Number.isInteger(fps) || fps < 1 || fps > MAX_FPS) {
    throw new VideoCompositeValidationError(`fps must be an integer in [1, ${MAX_FPS}] (got ${String(fps)})`);
  }
  if (typeof durationSec !== "number" || !Number.isFinite(durationSec) || durationSec <= 0 || durationSec > MAX_DURATION_SEC) {
    throw new VideoCompositeValidationError(
      `durationSec must be a finite number in (0, ${MAX_DURATION_SEC}] (got ${String(durationSec)})`,
    );
  }
  if (!Array.isArray(sampleAt)) {
    throw new VideoCompositeValidationError("sampleAt must be an array of numbers in [0, 1]");
  }
  for (const t of sampleAt) {
    if (typeof t !== "number" || !Number.isFinite(t) || t < 0 || t > 1) {
      throw new VideoCompositeValidationError(`sampleAt values must be finite numbers in [0, 1] (got ${String(t)})`);
    }
  }
  return [...new Set(sampleAt)].sort((a, b) => a - b);
}

/** Redact first, then take the tail — a cut that lands mid-path must not leak its remainder. */
function formatFfmpegFailure(detail: string, ffmpegPath: string): string {
  const redacted = redactAbsolutePaths(detail, [ffmpegPath]);
  return redacted.length > STDERR_TAIL ? redacted.slice(-STDERR_TAIL) : redacted;
}

// Absolute paths only: a root (`/` or `C:\`) plus at least one segment and a
// second separator, so ffmpeg's lone "/" version separators and fractions
// such as "30000/1001" survive.
const ABSOLUTE_PATH = /(?:\/|[A-Za-z]:[\\/])[^\s"'`=),\\/]+[\\/][^\s"'`=),]*/g;

function redactAbsolutePaths(text: string, known: readonly string[]): string {
  let out = text;
  for (const p of known) {
    out = out.split(p).join("ffmpeg");
  }
  return out.replace(ABSOLUTE_PATH, "<path>");
}
