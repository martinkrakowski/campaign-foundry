import "./env.js"; // load .env / .env.local before reading process.env
import {
  GenerateCampaignUseCase,
  type CampaignBrief,
  type ImageGeneratorPort,
  type PipelineResult,
} from "@campaignfoundry/CampaignOrchestration";
import {
  GeminiImageGenerator,
  NodeCanvasCompositor,
  ProceduralBackgroundGenerator,
} from "@campaignfoundry/CreativeGeneration";
import { BrandComplianceChecker } from "@campaignfoundry/GovernanceAndCompliance";
import { FileSystemExporter } from "@campaignfoundry/Distribution";
import type { Result } from "@campaignfoundry/shared";
import { outputRoot } from "./config.js";

/** Resolve the image generator: Google Imagen when a key is set, else procedural. */
function imageGenerator(): ImageGeneratorPort {
  const procedural = new ProceduralBackgroundGenerator();
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) return procedural;
  return new GeminiImageGenerator({ apiKey, model: process.env.IMAGEN_MODEL, fallback: procedural });
}

/**
 * Composition root — the one place that knows concrete adapters. Wires them into
 * the use case via constructor injection; everything above depends only on ports.
 */
export function buildPipeline(): GenerateCampaignUseCase {
  return new GenerateCampaignUseCase({
    imageGenerator: imageGenerator(),
    compositor: new NodeCanvasCompositor(),
    compliance: new BrandComplianceChecker(),
    exporter: new FileSystemExporter(outputRoot()),
  });
}

export function runCampaign(brief: CampaignBrief): Promise<Result<PipelineResult, Error>> {
  return buildPipeline().execute(brief);
}
