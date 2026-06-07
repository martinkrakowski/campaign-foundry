import { loadEnv } from "./env.js";
import {
  GenerateCampaignUseCase,
  type CampaignBrief,
  type ImageGeneratorPort,
  type PipelineResult,
  type RegenerationTarget,
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
 * Server-side allowlist of selectable image model ids — the security boundary for
 * the untrusted `?model=` query (the UI's curated list is not enforceable). Anything
 * else is rejected at the route, so callers can't invoke arbitrary OpenRouter models.
 * Keep in sync with the UI catalog in apps/web/src/lib/models.ts.
 */
export const ALLOWED_IMAGE_MODELS: readonly string[] = [
  "imagen",
  "procedural",
  "x-ai/grok-imagine-image-quality",
  "google/gemini-2.5-flash-image",
  "openai/gpt-5-image",
];

/**
 * Resolve the image generator, wrapped by input-asset reuse. The primary source is
 * chosen by `selected` (the UI's model picker); procedural is always the floor.
 *
 *   selected = undefined / "auto" → Imagen → OpenRouter (default) → procedural
 *   selected = "procedural"       → procedural only
 *   selected = "imagen"           → Imagen → OpenRouter (default) → procedural
 *   selected = "<provider>/<model>" → that OpenRouter model → procedural
 *
 * Each GenAI provider is only used when its key is present (else it falls through).
 */
function imageGenerator(selected?: string): ImageGeneratorPort {
  const procedural = new ProceduralBackgroundGenerator();
  const geminiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  const openRouterKey = process.env.OPENROUTER_API_KEY;

  // An OpenRouter generator for a given model, falling back to procedural.
  const openRouter = (model?: string): ImageGeneratorPort =>
    openRouterKey
      ? new OpenRouterImageGenerator({ apiKey: openRouterKey, model, fallback: procedural })
      : procedural;

  // Imagen with the OpenRouter default as its first fallback, then procedural.
  const imagen = (): ImageGeneratorPort =>
    geminiKey
      ? new GeminiImageGenerator({
          apiKey: geminiKey,
          model: process.env.IMAGEN_MODEL,
          fallback: openRouter(process.env.OPENROUTER_IMAGE_MODEL),
        })
      : openRouter(process.env.OPENROUTER_IMAGE_MODEL);

  let generator: ImageGeneratorPort;
  if (selected === "procedural") generator = procedural;
  else if (selected && selected.includes("/")) generator = openRouter(selected);
  else generator = imagen(); // "auto" / "imagen" / unset → default chain

  return new AssetReusingImageGenerator(generator);
}

/**
 * Composition root — the one place that knows concrete adapters. Wires them into
 * the use case via constructor injection; everything above depends only on ports.
 */
export function buildPipeline(imageModel?: string): GenerateCampaignUseCase {
  return new GenerateCampaignUseCase({
    imageGenerator: imageGenerator(imageModel),
    compositor: new NodeCanvasCompositor(process.env.MESSAGE_FONT),
    compliance: new BrandComplianceChecker(),
    exporter: new FileSystemExporter(outputRoot()),
  });
}

/**
 * Run a campaign. `imageModel` (from the UI's model picker) selects the primary
 * generator; `regenerateOnly` (the HITL re-roll) restricts the run to just those
 * creatives, leaving every other cell untouched.
 */
export function runCampaign(
  brief: CampaignBrief,
  imageModel?: string,
  regenerateOnly?: ReadonlyArray<RegenerationTarget>,
): Promise<Result<PipelineResult, Error>> {
  return buildPipeline(imageModel).execute(brief, regenerateOnly ? { regenerateOnly } : undefined);
}
