import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  getCapabilities,
  probeFfmpeg,
  recordFfmpegProbe,
  setCapabilities,
  type ProbeSpawn,
} from "../../lib/capabilities.js";
import plugin from "../ffmpeg-check.js";

function fakeProcess(opts: {
  code?: number | null;
  stderr?: string;
  error?: Error;
  hang?: boolean;
  throwOnSpawn?: unknown;
  noStderr?: boolean;
}): ProbeSpawn {
  return () => {
    if (opts.throwOnSpawn !== undefined) throw opts.throwOnSpawn;
    const stderr = opts.noStderr ? null : new PassThrough();
    const proc = Object.assign(new EventEmitter(), {
      stderr,
      stdout: new PassThrough(),
      stdin: null,
      killed: false,
      kill() {
        proc.killed = true;
        return true;
      },
    }) as unknown as ChildProcess & { killed: boolean };

    if (opts.hang) return proc as ChildProcess;

    queueMicrotask(() => {
      if (opts.error) {
        proc.emit("error", opts.error);
        return;
      }
      if (opts.stderr && stderr) stderr.end(opts.stderr);
      else stderr?.end();
      proc.emit("close", opts.code ?? 0);
    });
    return proc as ChildProcess;
  };
}

describe("probeFfmpeg", () => {
  test("returns motion true when ffmpeg -version exits 0", async () => {
    const cap = await probeFfmpeg({ spawn: fakeProcess({ code: 0 }), ffmpegPath: "/opt/ffmpeg" });
    expect(cap).toEqual({ motion: true });
  });

  test("returns a redacted reason on a non-zero exit with stderr", async () => {
    const cap = await probeFfmpeg({
      spawn: fakeProcess({ code: 1, stderr: "cannot exec /opt/ffmpeg: broken\n" }),
      ffmpegPath: "/opt/ffmpeg",
    });
    expect(cap.motion).toBe(false);
    expect(cap.reason).toMatch(/cannot exec ffmpeg/);
    expect(cap.reason).not.toMatch(/(?:^|[\s'"])\//);
  });

  test("names the exit code when stderr is empty", async () => {
    const cap = await probeFfmpeg({
      spawn: fakeProcess({ code: 2 }),
      ffmpegPath: "/opt/ffmpeg",
    });
    expect(cap).toEqual({ motion: false, reason: "ffmpeg -version exited 2" });
  });

  test("records a spawn error without leaking the binary path", async () => {
    const cap = await probeFfmpeg({
      spawn: fakeProcess({ error: new Error("spawn /opt/ffmpeg ENOENT") }),
      ffmpegPath: "/opt/ffmpeg",
    });
    expect(cap.motion).toBe(false);
    expect(cap.reason).toMatch(/ENOENT/);
    expect(cap.reason).not.toContain("/opt/ffmpeg");
  });

  test("times out, kills the process, and ignores a late close", async () => {
    const hung = fakeProcess({ hang: true });
    const childHolder: { proc?: ReturnType<ProbeSpawn> } = {};
    const spawn: ProbeSpawn = (command, args, options) => {
      const proc = hung(command, args, options);
      childHolder.proc = proc;
      return proc;
    };
    const cap = await probeFfmpeg({ spawn, timeoutMs: 20, ffmpegPath: "/opt/ffmpeg" });
    childHolder.proc?.emit("close", 0);
    childHolder.proc?.emit("error", new Error("late"));
    expect(cap).toEqual({ motion: false, reason: "ffmpeg -version timed out after 20ms" });
  });

  test("uses ffmpeg-static when ffmpegPath is omitted from opts", async () => {
    const cap = await probeFfmpeg({ spawn: fakeProcess({ code: 0 }) });
    expect(cap).toEqual({ motion: true });
  });

  test("returns unavailable when the ffmpeg path is empty", async () => {
    const cap = await probeFfmpeg({ ffmpegPath: null });
    expect(cap).toEqual({ motion: false, reason: "ffmpeg-static binary is not available" });
  });

  test("formats a non-Error thrown by spawn through String()", async () => {
    const cap = await probeFfmpeg({
      spawn: fakeProcess({ throwOnSpawn: "spawn exploded" }),
      ffmpegPath: "/opt/ffmpeg",
    });
    expect(cap).toEqual({ motion: false, reason: "spawn exploded" });
  });

  test("formats an Error thrown by spawn and redacts its path", async () => {
    const cap = await probeFfmpeg({
      spawn: fakeProcess({ throwOnSpawn: new Error("cannot spawn /opt/ffmpeg") }),
      ffmpegPath: "/opt/ffmpeg",
    });
    expect(cap.motion).toBe(false);
    expect(cap.reason).not.toContain("/opt/ffmpeg");
  });

  test("tolerates a child with no stderr stream", async () => {
    const cap = await probeFfmpeg({
      spawn: fakeProcess({ code: 1, noStderr: true }),
      ffmpegPath: "/opt/ffmpeg",
    });
    expect(cap).toEqual({ motion: false, reason: "ffmpeg -version exited 1" });
  });
});

describe("recordFfmpegProbe", () => {
  beforeEach(() => {
    setCapabilities({ motion: false, reason: "not probed" });
  });
  afterEach(() => vi.restoreAllMocks());

  test("stores a successful probe without warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    recordFfmpegProbe({ motion: true });
    expect(getCapabilities()).toEqual({ motion: true });
    expect(warn).not.toHaveBeenCalled();
  });

  test("warns with the probe reason when motion is unavailable", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    recordFfmpegProbe({ motion: false, reason: "no binary" });
    expect(getCapabilities()).toEqual({ motion: false, reason: "no binary" });
    expect(warn).toHaveBeenCalledWith("[ffmpeg-check] no binary");
  });

  test("falls back to a default warning when the reason is omitted", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    recordFfmpegProbe({ motion: false });
    expect(warn).toHaveBeenCalledWith("[ffmpeg-check] ffmpeg probe failed");
  });
});

describe("ffmpeg-check plugin", () => {
  beforeEach(() => {
    setCapabilities({ motion: false, reason: "not probed" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  test("records a real probe into capabilities without throwing", async () => {
    await plugin({} as never);
    const cap = getCapabilities();
    expect(typeof cap.motion).toBe("boolean");
    if (cap.motion) {
      expect(cap.reason).toBeUndefined();
    } else {
      expect(cap.reason).toEqual(expect.any(String));
    }
  });
});
