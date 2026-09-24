import { describe, test, expect } from "vitest";
import { spawn as realSpawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CanvasFfmpegVideoCompositor, type FfmpegSpawn } from "../CanvasFfmpegVideoCompositor.js";
import { canonicalMp4Request } from "./canonical-mp4-request.js";
import {
  compositorGoldenKey,
  goldenPlatformKeys,
  goldenRun,
  isRecordingGoldens,
  missingGoldenMapMessage,
  recordGoldenMap,
  resolveGoldenMap,
  type GoldenFixture,
  type GoldenMap,
  type GoldenRun,
} from "./compositor-golden-key.js";

import { projectRoot } from "@campaignfoundry/shared";
/**
 * VG2 — the MP4 byte golden. D10 claims motion bytes are frozen; the still
 * goldens hash PNGs and C1's motion goldens hash individual frames, but
 * neither touches what `CanvasFfmpegVideoCompositor` actually emits. This is
 * the first thing that measures the encoded file.
 *
 * Two hashes, not one: `fileHash` covers the whole MP4 (container framing
 * included), `streamHash` covers only the extracted H.264 elementary stream
 * (via `-bsf:v h264_mp4toannexb`, which strips every container-level byte —
 * moov/stbl/timestamps — leaving only the NAL units libx264 produced). A
 * `fileHash` mismatch with an unchanged `streamHash` means the container
 * stamped something (a muxer version, a timestamp); a `streamHash` mismatch
 * means the encoder itself changed. `ffmpegVersion`, `x264Version` and
 * `threads` are recorded beside the hashes so a future mismatch reads as a
 * version change, not a mystery (the x264 version and thread count are
 * parsed back out of the encoded bytes themselves — the SEI user-data NAL
 * embeds them, which is exactly the mechanism VG1 pins with `-threads 1`).
 *
 * One canonical timeline (VG-D5): C1's frame goldens already cover the
 * motion matrix. This asserts the encoder, not the renderer.
 */

const MP4_GOLDEN_FIELD_COUNT = 5;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const require = createRequire(import.meta.url);
const ffmpegStatic = require("ffmpeg-static") as string | null;
const ffmpegOverride = process.env.COMPOSITOR_FFMPEG_PATH;
const ffmpegPath =
  ffmpegOverride !== undefined
    ? ffmpegOverride === ""
      ? null
      : ffmpegOverride
    : typeof ffmpegStatic === "string"
      ? ffmpegStatic
      : null;
const ffmpegProbe = ffmpegPath
  ? spawnSync(ffmpegPath, ["-version"], { encoding: "utf8", timeout: 5_000 })
  : undefined;
const ffmpegOk = ffmpegProbe?.status === 0;
const skipReason = ffmpegOk
  ? undefined
  : `ffmpeg-static binary cannot execute${ffmpegProbe?.error ? ` (${ffmpegProbe.error.message})` : ffmpegProbe ? ` (exited ${ffmpegProbe.status})` : " (path is null)"}`;

/** "ffmpeg version 6.0 Copyright ..." -> "6.0" */
function parseFfmpegVersion(versionStdout: string): string {
  const match = /ffmpeg version (\S+)/.exec(versionStdout);
  if (!match)
    throw new Error(`could not parse ffmpeg version from: ${versionStdout.slice(0, 200)}`);
  return match[1];
}

/**
 * The x264 SEI user-data NAL embeds its own banner in the encoded bytes —
 * "x264 - core 164 r3075 66a5bc1 - ... - options: ... threads=1 ...".
 * Parsing it back out of the actual MP4 (rather than piping ffmpeg's stderr
 * through a second, hand-copied arg list) ties this golden to what
 * `CanvasFfmpegVideoCompositor` really produced: a drift in preset, crf or
 * `-threads` shows up here exactly because it shows up in the file.
 */
function parseX264Banner(video: Uint8Array): {
  readonly version: string;
  readonly threads: string;
} {
  const text = Buffer.from(video).toString("latin1");
  const match = /x264 - (core \d+ \S+ \S+) - .*?threads=(\d+)/.exec(text);
  if (!match)
    throw new Error("no x264 SEI banner found in the encoded MP4 (was -fflags +bitexact changed?)");
  return { version: match[1], threads: match[2] };
}

/** Extract the H.264 elementary stream (annex-B) via `-c copy`, no re-encode. */
function extractVideoStream(ffmpeg: string, mp4Path: string, outPath: string): Uint8Array {
  const result = spawnSync(
    ffmpeg,
    [
      "-y",
      "-i",
      mp4Path,
      "-map",
      "0:v",
      "-c",
      "copy",
      "-bsf:v",
      "h264_mp4toannexb",
      "-f",
      "h264",
      outPath,
    ],
    { timeout: 30_000 },
  );
  if (result.status !== 0) {
    throw new Error(
      `stream extraction failed (exit ${String(result.status)}): ${result.stderr?.toString().slice(-2000)}`,
    );
  }
  return readFileSync(outPath);
}

const fixturesDir =
  process.env.COMPOSITOR_GOLDEN_FIXTURE_DIR ??
  join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const goldensPath = join(fixturesDir, "compositor-goldens-mp4.json");
const fixture = JSON.parse(readFileSync(goldensPath, "utf8")) as GoldenFixture;

const finishGolden = (key: string, observed: GoldenMap, run: GoldenRun): void => {
  if (run.kind === "record") {
    recordGoldenMap(goldensPath, key, observed, MP4_GOLDEN_FIELD_COUNT);
    return;
  }
  expect(observed).toEqual(run.map);
};

describe("CanvasFfmpegVideoCompositor byte golden (VG2)", () => {
  const key = compositorGoldenKey();
  const recording = isRecordingGoldens();
  const goldens = resolveGoldenMap(fixture, key);
  const missingMessage = missingGoldenMapMessage(key, goldenPlatformKeys(fixture), {
    fixtureFile: "compositor-goldens-mp4.json",
    cellsHint:
      "5 fields (fileHash, streamHash, ffmpegVersion, x264Version, threads) for the one canonical timeline",
  });

  test.skipIf(!recording && !ffmpegOk)(
    (!recording ? skipReason : undefined) ??
      "the canonical timeline's encoded MP4 matches the committed byte golden for this platform (D10)",
    { timeout: 60_000 },
    async () => {
      if (!ffmpegOk) throw new Error(skipReason);
      if (!ffmpegPath) throw new Error("ffmpeg-static binary is not available");
      const run = goldenRun(goldens, recording, missingMessage);

      // Same binary that encodes must be the same binary this file probes and
      // extracts streams with (`ffmpegPath`, honouring COMPOSITOR_FFMPEG_PATH) —
      // otherwise a hash mismatch could mean "two different ffmpeg builds",
      // not "the encoder changed". VE3b1's audio golden already had this shape.
      const { video } = await new CanvasFfmpegVideoCompositor({
        ffmpegPath,
        assetRoot: projectRoot(),
      }).compositeVideo(canonicalMp4Request());
      const banner = parseX264Banner(video);

      const dir = mkdtempSync(join(tmpdir(), "cf-mp4-golden-"));
      try {
        const mp4Path = join(dir, "canonical.mp4");
        writeFileSync(mp4Path, Buffer.from(video));
        const stream = extractVideoStream(ffmpegPath, mp4Path, join(dir, "canonical.h264"));

        const observed: GoldenMap = {
          fileHash: sha256(video),
          streamHash: sha256(stream),
          ffmpegVersion: parseFfmpegVersion(ffmpegProbe?.stdout ?? ""),
          x264Version: banner.version,
          threads: banner.threads,
        };

        finishGolden(key, observed, run);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!ffmpegOk)(
    skipReason ??
      "the encode spawns the resolved COMPOSITOR_FFMPEG_PATH binary, not the adapter's ffmpeg-static default (X31)",
    { timeout: 60_000 },
    async () => {
      if (!ffmpegPath) throw new Error("ffmpeg-static binary is not available");
      // The adapter injects every encode through its `spawn` option, so the
      // command it was invoked with is directly observable — no shell wrapper,
      // no marker file, no subprocess re-entry, and no POSIX-shell assumption.
      // Delegate to the real spawn afterwards so the recorded invocation is
      // the one that actually produced the bytes.
      const invocations: Array<{ readonly command: string; readonly args: readonly string[] }> = [];
      const spawn: FfmpegSpawn = (command, args, options) => {
        invocations.push({ command, args });
        return realSpawn(command, [...args], options);
      };
      // The alias (a hard link to the resolved binary: same inode, different
      // path) makes the assertion bite with or without the override set. The
      // adapter's own default is `ffmpeg-static`'s path; dropping the
      // constructor argument silently falls back to it, and a recorded
      // command of the default path can never equal this alias.
      const dir = mkdtempSync(join(tmpdir(), "cf-x31-ffmpeg-path-"));
      try {
        const alias = join(dir, "ffmpeg-resolved");
        linkSync(ffmpegPath, alias);

        await new CanvasFfmpegVideoCompositor({
          ffmpegPath: alias,
          spawn,
          assetRoot: projectRoot(),
        }).compositeVideo(canonicalMp4Request());

        expect(invocations.map((call) => call.command)).toEqual([alias]);
        expect(invocations[0].args).toContain("libx264");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test.runIf(!process.env.COMPOSITOR_BYTE_GOLDEN_SUBPROCESS)(
    "with the record flag set and the probe forced to fail, the suite fails rather than skipping",
    { timeout: 30_000 },
    () => {
      const vitestBin = fileURLToPath(
        new URL("../../../../../../node_modules/vitest/vitest.mjs", import.meta.url),
      );
      const target = fileURLToPath(import.meta.url);

      const recordRun = spawnSync(process.execPath, [vitestBin, "run", target], {
        env: {
          ...process.env,
          RECORD_COMPOSITOR_GOLDENS: "1",
          COMPOSITOR_FFMPEG_PATH: "/dev/null",
          COMPOSITOR_BYTE_GOLDEN_SUBPROCESS: "1",
        },
        encoding: "utf8",
      });
      expect(recordRun.status).not.toBe(0);
      expect(recordRun.stdout + (recordRun.stderr ?? "")).toMatch(
        /ffmpeg-static binary cannot execute/,
      );

      const assertRun = spawnSync(process.execPath, [vitestBin, "run", target], {
        env: {
          ...process.env,
          RECORD_COMPOSITOR_GOLDENS: "0",
          COMPOSITOR_FFMPEG_PATH: "/dev/null",
          COMPOSITOR_BYTE_GOLDEN_SUBPROCESS: "1",
        },
        encoding: "utf8",
      });
      expect(assertRun.status).toBe(0);
      expect(assertRun.stdout).toMatch(/skipped/);
    },
  );
});
