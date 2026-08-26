import { spawn as defaultSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createRequire } from "node:module";

export type Capabilities = { motion: boolean; reason?: string };

export type ProbeSpawn = (
  command: string,
  args: readonly string[],
  options?: SpawnOptions,
) => ChildProcess;

const require = createRequire(import.meta.url);
const ffmpegStatic = require("ffmpeg-static") as string | null;
const DEFAULT_TIMEOUT_MS = 5_000;

let current: Capabilities = { motion: false, reason: "not probed" };

export function getCapabilities(): Capabilities {
  return current;
}

export function setCapabilities(c: Capabilities): void {
  current = c;
}

export async function probeFfmpeg(opts?: {
  spawn?: ProbeSpawn;
  timeoutMs?: number;
  ffmpegPath?: string | null;
}): Promise<Capabilities> {
  const ffmpegPath = opts?.ffmpegPath !== undefined ? opts.ffmpegPath : ffmpegStatic;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawnFn = opts?.spawn ?? defaultSpawn;

  if (!ffmpegPath) {
    return { motion: false, reason: "ffmpeg-static binary is not available" };
  }

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
        finish({ motion: true });
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

function redactAbsolutePaths(text: string, known: readonly string[]): string {
  let out = text;
  for (const p of known) {
    out = out.split(p).join("ffmpeg");
  }
  return out.replace(/(?:\/|[A-Za-z]:[\\/])[^\s"'`=),]+/g, "<path>");
}
