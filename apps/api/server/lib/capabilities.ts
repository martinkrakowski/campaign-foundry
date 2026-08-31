import { spawn as defaultSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { accessSync, constants } from "node:fs";
// Static ESM import on purpose: `nitro build` traces static imports into
// `.output/server/node_modules`, but a `createRequire(import.meta.url)(...)` was
// invisible to the tracer, so production boot died with "Cannot find module
// 'ffmpeg-static'" before the probe below could warn. See nitro.config.ts.
import ffmpegStatic from "ffmpeg-static";

export type Capabilities = { motion: boolean; reason?: string };

export type ProbeSpawn = (
  command: string,
  args: readonly string[],
  options?: SpawnOptions,
) => ChildProcess;

const DEFAULT_TIMEOUT_MS = 5_000;
const UNAVAILABLE = "ffmpeg-static binary is not available";

/** The boot snapshot before the probe has landed — a transient state, never a verdict. */
export const NOT_PROBED_REASON = "not probed";

// Nitro does not await async plugins before serving, so a request that arrives
// while `ffmpeg-check` is still probing sees this initial "not probed" snapshot.
let current: Capabilities = { motion: false, reason: NOT_PROBED_REASON };

// Resolved by the first real probe result, and re-armed whenever the snapshot is
// reset to "not probed". Run paths await this so a request landing in the boot
// window waits out the remaining probe instead of reading the transient snapshot
// as a permanent verdict.
let notifyProbed!: () => void;
let probed = new Promise<void>((resolve) => {
  notifyProbed = resolve;
});

export function getCapabilities(): Capabilities {
  return current;
}

export type FfmpegBinary = { path: string; reason?: undefined } | { path: null; reason: string };

/**
 * Resolve the ffmpeg-static binary lazily and never throw: a null export
 * (unsupported platform), a missing file, or a non-executable one all degrade
 * to a reason the probe surfaces as `{ motion: false, reason }`.
 */
export function resolveFfmpegBinary(
  candidate: string | null = ffmpegStatic,
  check: (path: string) => void = (path) => accessSync(path, constants.X_OK),
): FfmpegBinary {
  if (typeof candidate !== "string" || candidate.length === 0) {
    return { path: null, reason: UNAVAILABLE };
  }
  try {
    check(candidate);
    return { path: candidate };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { path: null, reason: `${UNAVAILABLE}: ${redactAbsolutePaths(detail, [candidate])}` };
  }
}

export function setCapabilities(c: Capabilities): void {
  current = c;
  if (c.reason === NOT_PROBED_REASON) {
    // Back into a boot window (tests reset to this): re-arm so waiters pend again.
    probed = new Promise((resolve) => {
      notifyProbed = resolve;
    });
    return;
  }
  notifyProbed();
}

/** Upper bound for a run waiting on the boot probe; matches the probe's own deadline. */
export const PROBE_WAIT_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;

/** Wait deadline for run paths; tests shrink it to reach the still-pending answer deterministically. */
export const probeWait = { timeoutMs: PROBE_WAIT_TIMEOUT_MS };

/** The 503 body run paths answer when the probe is still outstanding after the wait. */
export const PROBE_PENDING_ERROR =
  "motion capability has not finished probing — the server is still starting; retry the same request shortly (the brief is not invalid)";

/**
 * The snapshot, waiting out a pending boot probe first. Run paths call this before
 * validating so a request in the boot window is answered from the probe's real
 * verdict rather than the transient "not probed" snapshot. The probe settles within
 * its own timeout, so the wait is bounded; `opts.timeoutMs` short-circuits it
 * (0 = no wait) so tests reach the still-pending answer deterministically.
 */
export async function waitForCapabilities(opts?: { timeoutMs?: number }): Promise<Capabilities> {
  if (current.reason !== NOT_PROBED_REASON) return current;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, opts?.timeoutMs ?? probeWait.timeoutMs);
  });
  await Promise.race([probed, deadline]);
  clearTimeout(timer);
  return current;
}

export async function probeFfmpeg(opts?: {
  spawn?: ProbeSpawn;
  timeoutMs?: number;
  ffmpegPath?: string | null;
}): Promise<Capabilities> {
  const binary = opts?.ffmpegPath !== undefined ? resolveFfmpegBinary(opts.ffmpegPath, () => {}) : resolveFfmpegBinary();
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawnFn = opts?.spawn ?? defaultSpawn;

  if (binary.path === null) {
    return { motion: false, reason: binary.reason };
  }
  const ffmpegPath = binary.path;

  return await new Promise((resolve) => {
    let settled = false;
    const handle: { timer?: ReturnType<typeof setTimeout> } = {};
    const finish = (cap: Capabilities) => {
      if (settled) return;
      settled = true;
      if (handle.timer !== undefined) clearTimeout(handle.timer);
      resolve(cap);
    };

    let child: ChildProcess;
    try {
      child = spawnFn(ffmpegPath, ["-version"], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      finish({
        motion: false,
        reason: redactAbsolutePaths(error instanceof Error ? error.message : String(error), [ffmpegPath]),
      });
      return;
    }

    handle.timer = setTimeout(() => {
      child.kill();
      finish({ motion: false, reason: `ffmpeg -version timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });

    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.once("error", (error) => {
      finish({
        motion: false,
        reason: redactAbsolutePaths(error.message, [ffmpegPath]),
      });
    });

    child.once("close", (code) => {
      if (code === 0) {
        const match = stdout.match(/ffmpeg version\s+([^\s]+)/i);
        const version = match?.[1];
        finish({ motion: true, ...(version ? { version } : {}) });
        return;
      }
      const detail = stderr.trim() || `ffmpeg -version exited ${code}`;
      finish({ motion: false, reason: redactAbsolutePaths(detail, [ffmpegPath]) });
    });
  });
}

export function recordFfmpegProbe(cap: Capabilities): void {
  setCapabilities(cap);
  if (!cap.motion) {
    console.warn(`[ffmpeg-check] ${cap.reason ?? "ffmpeg probe failed"}`);
  }
}

// Absolute paths only: a root plus at least one segment and a second separator,
// so ffmpeg's lone "/" version separators survive (mirrors the adapter).
const ABSOLUTE_PATH = /(?:\/|[A-Za-z]:[\\/])[^\s"'`=),\\/]+[\\/][^\s"'`=),]*/g;

function redactAbsolutePaths(text: string, known: readonly string[]): string {
  let out = text;
  for (const p of known) {
    out = out.split(p).join("ffmpeg");
  }
  return out.replace(ABSOLUTE_PATH, "<path>");
}
