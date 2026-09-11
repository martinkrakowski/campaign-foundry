import { describe, test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { CanvasFfmpegVideoCompositor } from "../CanvasFfmpegVideoCompositor.js";
import { canonicalMp4Request } from "./canonical-mp4-request.js";

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

/**
 * VG1's probe (VG-D2). This alone proves almost nothing: run twice in one
 * process holds core count, CPU feature set and the ffmpeg-static binary all
 * constant, so it can only catch time- or randomness-based inputs — which
 * `+bitexact` already eliminates. It would pass even with `-threads` unset.
 * It is committed anyway, because it is the thing that keeps the answer true
 * as the encoder args evolve; the real cross-machine proof lives in the PR
 * description (two independent CI runner instances agreeing on the byte
 * golden in CanvasFfmpegVideoCompositor.byte-golden.test.ts), not here.
 */
describe("CanvasFfmpegVideoCompositor determinism probe (VG1)", () => {
  test.runIf(process.env.CI)("the ffmpeg-static binary executes on CI", () => {
    expect(ffmpegOk, skipReason).toBe(true);
  });

  test.skipIf(!ffmpegOk)(
    skipReason ?? "encoding the canonical timeline twice in one process yields byte-identical MP4s",
    { timeout: 60_000 },
    async () => {
      const first = await new CanvasFfmpegVideoCompositor().compositeVideo(canonicalMp4Request());
      const second = await new CanvasFfmpegVideoCompositor().compositeVideo(canonicalMp4Request());
      expect(sha256(second.video)).toBe(sha256(first.video));
      expect(Buffer.from(second.video).equals(Buffer.from(first.video))).toBe(true);
    },
  );
});
