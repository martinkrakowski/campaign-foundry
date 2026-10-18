import { test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GlobalFonts } from "@napi-rs/canvas";
import { AspectRatio, type CompositeRequest } from "@campaignfoundry/CampaignOrchestration";
import { NodeCanvasCompositor } from "../NodeCanvasCompositor.js";
import { ProceduralBackgroundGenerator } from "../ProceduralBackgroundGenerator.js";
import { projectRoot } from "@campaignfoundry/shared";
import { fsInputs } from "./fs-inputs.js";
/**
 * Regression test (brief `golden-fonts`, 2026-10-18): `registerBundledFonts()`
 * used to live ONLY in the NodeCanvasCompositor constructor, so a caller that
 * used the static `prepare()`/`draw()` without first constructing a compositor
 * rendered the headline in the machine's fallback sans-serif instead of the
 * bundled Inter. prepare() now registers the bundled fonts itself, so the font
 * never depends on construction order.
 *
 * Why a SUBPROCESS: the canvas font registry (@napi-rs/canvas `GlobalFonts`) is
 * process-global, so a test in a shared vitest worker could see Inter already
 * registered by an earlier test and pass while the bug is present. The outer
 * test re-runs this file in a fresh `node <vitest.mjs> run` subprocess with
 * `PREPARE_FONTS_SUBPROCESS=1` (the pattern of
 * CanvasFfmpegVideoCompositor.byte-golden.test.ts) and asserts that fresh run
 * passes; the inner test only executes there.
 */

const MESSAGE = "Stay wild, stay hydrated";
const BRAND = "#1473E6";
const LOGO = "assets/inputs/hydra-logo.png";

const ratio = (v: string) => {
  const r = AspectRatio.create(v);
  if (!r.success) throw r.error;
  return r.value;
};

const product = { id: "hydra-bottle", name: "Hydra Bottle", primaryColor: BRAND, logoPath: LOGO };
const bgCtx = { campaignMessage: MESSAGE, targetAudience: "a", targetRegion: "r" };

test.runIf(process.env.PREPARE_FONTS_SUBPROCESS === "1")(
  "prepare() registers the bundled Inter without a constructed compositor",
  async () => {
    if (GlobalFonts.has("Inter")) {
      throw new Error(
        'GlobalFonts.has("Inter") was already true before this test ran anything: this machine ' +
          "has a system Inter installed, so the test cannot prove anything.",
      );
    }
    const backgrounds = new ProceduralBackgroundGenerator();
    const bg = await backgrounds.resolveBackground(product, ratio("1:1"), bgCtx);
    const request: CompositeRequest = {
      background: bg.image,
      message: MESSAGE,
      brandColor: BRAND,
      logoPath: LOGO,
      canvas: { ratio: "1:1" },
      layout: "headline-bottom",
      tone: "bold",
    };
    await NodeCanvasCompositor.prepare(request, "Inter", fsInputs(projectRoot()));
    expect(GlobalFonts.has("Inter")).toBe(true);
  },
);

test.runIf(process.env.PREPARE_FONTS_SUBPROCESS !== "1")(
  "in a fresh vitest subprocess, prepare() alone registers the bundled Inter",
  { timeout: 60_000 },
  () => {
    const vitestBin = fileURLToPath(
      new URL("../../../../../../node_modules/vitest/vitest.mjs", import.meta.url),
    );
    const target = fileURLToPath(import.meta.url);
    const run = spawnSync(process.execPath, [vitestBin, "run", target], {
      env: { ...process.env, PREPARE_FONTS_SUBPROCESS: "1" },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/1 passed/);
  },
);
