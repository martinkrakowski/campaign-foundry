import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenerateCampaignUseCase, type CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { ALLOWED_IMAGE_MODELS, buildPipeline, runCampaign } from "../pipeline.js";

const brief: CampaignBrief = {
  id: "camp",
  targetRegion: "DE",
  targetAudience: "a",
  campaignMessage: "Hi",
  products: [
    { id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "assets/inputs/hydra-logo.png" },
    { id: "beta", name: "B", primaryColor: "#E0218A", logoPath: "assets/inputs/trail-logo.png" },
  ],
};

const KEYS = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENROUTER_API_KEY"];

describe("pipeline composition root", () => {
  let dir: string;
  const snap: Record<string, string | undefined> = {};
  const origOut = process.env.OUTPUT_DIR;

  beforeEach(() => {
    for (const k of KEYS) {
      snap[k] = process.env[k];
      delete process.env[k];
    }
    dir = mkdtempSync(join(tmpdir(), "cf-pipeline-"));
    process.env.OUTPUT_DIR = dir;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const k of KEYS) {
      if (snap[k] === undefined) delete process.env[k];
      else process.env[k] = snap[k];
    }
    if (origOut === undefined) delete process.env.OUTPUT_DIR;
    else process.env.OUTPUT_DIR = origOut;
  });

  test("ALLOWED_IMAGE_MODELS lists the curated ids", () => {
    expect(ALLOWED_IMAGE_MODELS).toContain("procedural");
    expect(ALLOWED_IMAGE_MODELS).toContain("imagen");
    expect(ALLOWED_IMAGE_MODELS).toContain("x-ai/grok-imagine-image-quality");
  });

  test("buildPipeline wires a use case for every generator-selection branch", () => {
    // Construction is lazy (no network), so this exercises each branch of imageGenerator().
    expect(buildPipeline("procedural")).toBeInstanceOf(GenerateCampaignUseCase);
    expect(buildPipeline()).toBeInstanceOf(GenerateCampaignUseCase); // default, no keys → procedural floor

    process.env.OPENROUTER_API_KEY = "o";
    expect(buildPipeline("x-ai/grok-imagine-image-quality")).toBeInstanceOf(GenerateCampaignUseCase); // explicit OpenRouter model
    expect(buildPipeline("imagen")).toBeInstanceOf(GenerateCampaignUseCase); // no gemini → OpenRouter

    process.env.GEMINI_API_KEY = "g";
    expect(buildPipeline("imagen")).toBeInstanceOf(GenerateCampaignUseCase); // Imagen + OpenRouter fallback
  });

  test("runCampaign executes fully offline with the procedural model", async () => {
    const r = await runCampaign(brief, "procedural");
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.value.assets).toHaveLength(6); // 2 products × 3 ratios × 1 default treatment
      expect(r.value.assets.every((a) => a.backgroundSource === "procedural")).toBe(true);
    }
  });

  test("runCampaign forwards regenerateOnly targets", async () => {
    const r = await runCampaign(brief, "procedural", [{ productId: "alpha", aspectRatio: "1:1", treatment: "default" }]);
    expect(r.success).toBe(true);
    if (r.success) expect(r.value.assets.map((a) => a.outputPath)).toEqual(["alpha/1x1.png"]);
  });
});
