import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const probeMock = vi.hoisted(() =>
  vi.fn(async (): Promise<{ motion: boolean; reason?: string }> => ({ motion: true })),
);

vi.mock("../../server/lib/capabilities.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../server/lib/capabilities.js")>();
  return { ...actual, probeFfmpeg: probeMock };
});

import { main } from "../generate.js";

// Same guard as the CanvasFfmpegVideoCompositor adapter tests: the motion
// integration test encodes through the real ffmpeg-static binary and must skip
// (not fail) on a host where it cannot execute — but never silently on CI.
const require = createRequire(import.meta.url);
const ffmpegStatic = require("ffmpeg-static") as string | null;
const ffmpegProbe = ffmpegStatic
  ? spawnSync(ffmpegStatic, ["-version"], { encoding: "utf8", timeout: 5_000 })
  : undefined;
const ffmpegOk = ffmpegProbe?.status === 0;
const skipReason = ffmpegOk
  ? undefined
  : `ffmpeg-static binary cannot execute${ffmpegProbe?.error ? ` (${ffmpegProbe.error.message})` : ffmpegProbe ? ` (exited ${ffmpegProbe.status})` : " (path is null)"}`;

const KEYS = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENROUTER_API_KEY"];

const briefJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: "camp",
    targetRegion: "DE",
    targetAudience: "a",
    campaignMessage: "Hi",
    products: [
      { id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "assets/inputs/hydra-logo.png" },
      { id: "beta", name: "B", primaryColor: "#E0218A", logoPath: "assets/inputs/missing-logo.png" },
    ],
    ...over,
  });

describe("generate CLI main()", () => {
  let dir: string;
  const snap: Record<string, string | undefined> = {};
  const origOut = process.env.OUTPUT_DIR;
  const origExit = process.exitCode;

  beforeEach(() => {
    for (const k of KEYS) {
      snap[k] = process.env[k];
      delete process.env[k]; // force the offline procedural path
    }
    probeMock.mockReset();
    probeMock.mockResolvedValue({ motion: true });
    dir = mkdtempSync(join(tmpdir(), "cf-cli-"));
    process.env.OUTPUT_DIR = dir;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = origExit;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const k of KEYS) {
      if (snap[k] === undefined) delete process.env[k];
      else process.env[k] = snap[k];
    }
    if (origOut === undefined) delete process.env.OUTPUT_DIR;
    else process.env.OUTPUT_DIR = origOut;
    process.exitCode = origExit;
    vi.restoreAllMocks();
  });

  test("generates from the default sample brief and writes a report", async () => {
    await main(); // no arg → arg('--brief') ?? default sample brief
    expect(existsSync(resolve(dir, "report.json"))).toBe(true);
    expect(process.exitCode).not.toBe(1);
  });

  test("reads the brief path from the --brief argv flag", async () => {
    const path = join(dir, "argv.json");
    writeFileSync(path, briefJson());
    process.argv.push("--brief", path);
    try {
      await main(); // no arg → falls through to arg('--brief')
    } finally {
      process.argv.splice(-2, 2);
    }
    expect(existsSync(resolve(dir, "reports", "camp.json"))).toBe(true);
  });

  test("renders ok and warn rows (good logo vs missing logo)", async () => {
    const path = join(dir, "mixed.json");
    writeFileSync(path, briefJson());
    await main(path);
    expect(existsSync(resolve(dir, "reports", "camp.json"))).toBe(true);
  });

  test("exits 1 on a business-rule failure", async () => {
    const path = join(dir, "solo.json");
    writeFileSync(path, briefJson({ products: [{ id: "solo", name: "S", primaryColor: "#111111", logoPath: "x.png" }] }));
    await main(path);
    expect(process.exitCode).toBe(1);
  });

  test.runIf(process.env.CI)("the ffmpeg-static binary executes on CI", () => {
    expect(ffmpegOk, skipReason).toBe(true);
  });

  test.skipIf(!ffmpegOk)(
    skipReason ?? "integration: a motion brief writes mp4 + poster through the real ffmpeg-static encoder",
    async () => {
      const path = join(dir, "motion.json");
      writeFileSync(
        path,
        briefJson({
          id: "motion",
          mode: "variation",
          variation: { count: 1, seed: 1, axes: { motion: ["accent-wipe"], duration: [2], layout: ["headline-bottom"], tone: ["bold"] } },
          output: { formats: ["motion"], platforms: ["instagram-reel"] },
        }),
      );
      await main(path);
      expect(process.exitCode).not.toBe(1);
      const report = JSON.parse(readFileSync(resolve(dir, "reports", "motion.json"), "utf8")) as {
        assets: Array<{ outputPath: string; videoPath?: string; format?: string; durationSec?: number }>;
      };
      expect(report.assets).toHaveLength(1);
      const [asset] = report.assets;
      expect(asset).toMatchObject({ format: "motion", durationSec: 2 });
      expect(asset.videoPath).toMatch(/\/v0\.mp4$/);
      expect(existsSync(resolve(dir, asset.videoPath!))).toBe(true);
      expect(existsSync(resolve(dir, asset.outputPath))).toBe(true);
      expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toMatch(/v0\.mp4 \(\+poster\)/);
    },
    60_000,
  );

  test("warns on a failed ffmpeg probe without changing the exit code", async () => {
    probeMock.mockResolvedValueOnce({ motion: false, reason: "no binary" });
    const path = join(dir, "probe.json");
    writeFileSync(path, briefJson());
    await main(path);
    expect(process.exitCode).not.toBe(1);
    expect(probeMock).toHaveBeenCalledWith({ timeoutMs: 2_000 });
    expect(vi.mocked(console.warn).mock.calls.flat().join(" ")).toMatch(/motion unavailable: no binary/);
  });

  test("warns and writes no creatives when the legal gate halts", async () => {
    const path = join(dir, "halt.json");
    writeFileSync(path, briefJson({ campaignMessage: "A guaranteed miracle cure" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await main(path);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/halted at the legal gate/);
  });
});
