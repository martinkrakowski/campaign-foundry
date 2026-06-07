import { loadEnv } from "./env.js";
import {
  GenerateCampaignUseCase,
  type CampaignBrief,
  type ImageGeneratorPort,
  type PipelineResult,
} from "@campaignfoundry/CampaignOrchestration";
import {
  AssetReusingImageGenerator,
  GeminiImageGenerator,
  NodeCanvasCompositor,
  OpenRouterImageGenerator,
  ProceduralBackgroundGenerator,
} from "@campaignfoundry/CreativeGeneration";
import { BrandComplianceChecker } from "@campaignfoundry/GovernanceAndCompliance";
import { FileSystemExporter } from "@campaignfoundry/Distribution";
import type { Result } from "@campaignfoundry/shared";
import { outputRoot } from "./config.js";

// Load .env before any process.env read below. Called (not a bare side-effect
// import) so Nitro's bundler can't tree-shake it — that was leaving GEMINI_API_KEY
// unset in the server and silently falling back to the procedural generator.
loadEnv();

/**
 * Resolve the image generator as a graceful fallback chain, wrapped by input-asset
 * reuse:
 *
 *   reuse asset → Imagen → OpenRouter (e.g. Grok Imagine) → procedural gradient
 *
 * Each GenAI provider is only inserted when its key is present, so the chain is
 * "whatever's configured, then procedural". When Imagen is rate-limited/unavailable
 * it falls through to OpenRouter; if that's also unavailable, the offline gradient.
 */
function imageGenerator(): ImageGeneratorPort {
  const procedural = new ProceduralBackgroundGenerator();

  // Second GenAI source (different provider/quota) before the procedural floor.
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  const afterImagen: ImageGeneratorPort = openRouterKey
    ? new OpenRouterImageGenerator({
        apiKey: openRouterKey,
        model: process.env.OPENROUTER_IMAGE_MODEL,
        fallback: procedural,
      })
    : procedural;

  const geminiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  const generator = geminiKey
    ? new GeminiImageGenerator({ apiKey: geminiKey, model: process.env.IMAGEN_MODEL, fallback: afterImagen })
    : afterImagen;

  return new AssetReusingImageGenerator(generator);
}

/**
 * Composition root — the one place that knows concrete adapters. Wires them into
 * the use case via constructor injection; everything above depends only on ports.
 */
export function buildPipeline(): GenerateCampaignUseCase {
  return new GenerateCampaignUseCase({
    imageGenerator: imageGenerator(),
    compositor: new NodeCanvasCompositor(process.env.MESSAGE_FONT),
    compliance: new BrandComplianceChecker(),
    exporter: new FileSystemExporter(outputRoot()),
  });
}

export function runCampaign(brief: CampaignBrief): Promise<Result<PipelineResult, Error>> {
  return buildPipeline().execute(brief);
}
