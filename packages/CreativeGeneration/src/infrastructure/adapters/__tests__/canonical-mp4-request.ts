/**
 * VG (the MP4 byte golden): one canonical short-video timeline, shared by the
 * determinism probe (`CanvasFfmpegVideoCompositor.determinism.test.ts`) and
 * the byte golden (`CanvasFfmpegVideoCompositor.byte-golden.test.ts`), so both
 * tests encode exactly the same thing. C1's frame goldens already cover the
 * motion matrix (48 cells, 2 layouts x 4 kinds) — this asserts the encoder,
 * not the renderer, so one timeline is enough (VG-D5).
 */
import { createCanvas } from "@napi-rs/canvas";
import type { VideoCompositeRequest } from "@campaignfoundry/CampaignOrchestration";

/** Deterministic — no randomness, no clock. */
function canonicalBackground(): Uint8Array {
  const c = createCanvas(16, 16);
  const ctx = c.getContext("2d");
  const gradient = ctx.createLinearGradient(0, 0, 16, 16);
  gradient.addColorStop(0, "#1473E6");
  gradient.addColorStop(1, "#003366");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 16, 16);
  return c.toBuffer("image/png");
}

/**
 * Small enough to encode fast (12 frames at 6 fps), large enough to exercise
 * a real ken-burns pose sweep and the legacy single-message copy path.
 */
export function canonicalMp4Request(): VideoCompositeRequest {
  return {
    background: canonicalBackground(),
    message: "Stay wild, stay hydrated",
    brandColor: "#1473E6",
    logoPath: "assets/inputs/hydra-logo.png",
    canvas: { ratio: "9:16" },
    pixelSize: { width: 108, height: 192 },
    layout: "headline-bottom",
    tone: "bold",
    durationSec: 2,
    fps: 6,
    motion: "ken-burns-in",
    sampleAt: [0, 1],
  };
}
