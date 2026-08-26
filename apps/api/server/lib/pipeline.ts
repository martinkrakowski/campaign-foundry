import { join } from "node:path";
import { loadEnv } from "./env.js";
import {
  GenerateCampaignUseCase,
  type CampaignBrief,
  type CopyGeneratorPort,
  type ImageGeneratorPort,
  type PipelineResult,
  type PlanInput,
  type RegenerationTarget,
} from "@campaignfoundry/CampaignOrchestration";
import {
  AssetReusingImageGenerator,
  FileSystemBackgroundCache,
  FireflyImageGenerator,
  GeminiImageGenerator,
  NodeCanvasCompositor,
  OpenRouterCopyGenerator,
  OpenRouterImageGenerator,
  ProceduralBackgroundGenerator,
} from "@campaignfoundry/CreativeGeneration";
import { BrandComplianceChecker } from "@campaignfoundry/GovernanceAndCompliance";
import { FileSystemExporter } from "@campaignfoundry/Distribution";
import { err, type Result } from "@campaignfoundry/shared";
import { outputRoot } from "./config.js";
import { planInputFor, pooledPlanner } from "./pools.js";

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
  "firefly",
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
 *   selected = "firefly"          → Adobe Firefly → Imagen → OpenRouter → procedural
 *   selected = "<provider>/<model>" → that OpenRouter model → procedural
 *
 * Each GenAI provider is only used when its credentials are present (else it falls
 * through). Adopting Firefly was a one-line addition here — the domain never changed.
 *
 * The `genai` variation axis decides *whether* GenAI is used for a cell;
 * `selected` (`?model=`) still decides *which* provider. `paletteShift` is
 * applied only by ProceduralBackgroundGenerator.
 */
function imageGenerator(selected?: string): ImageGeneratorPort {
  const procedural = new ProceduralBackgroundGenerator();
  const cache = new FileSystemBackgroundCache(join(outputRoot(), "cache"));
  const geminiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  const fireflyId = process.env.FIREFLY_CLIENT_ID;
  const fireflySecret = process.env.FIREFLY_CLIENT_SECRET;

  // An OpenRouter generator for a given model, falling back to procedural.
  const openRouter = (model?: string): ImageGeneratorPort =>
    openRouterKey
      ? new OpenRouterImageGenerator({ apiKey: openRouterKey, model, fallback: procedural, cache })
      : procedural;

  // Imagen with the OpenRouter default as its first fallback, then procedural.
  const imagen = (): ImageGeneratorPort =>
    geminiKey
      ? new GeminiImageGenerator({
          apiKey: geminiKey,
          model: process.env.IMAGEN_MODEL,
          fallback: openRouter(process.env.OPENROUTER_IMAGE_MODEL),
          cache,
        })
      : openRouter(process.env.OPENROUTER_IMAGE_MODEL);

  // Adobe Firefly Services, degrading to the default chain when it's unavailable or
  // its credentials are absent.
  const firefly = (): ImageGeneratorPort =>
    fireflyId && fireflySecret
      ? new FireflyImageGenerator({
          clientId: fireflyId,
          clientSecret: fireflySecret,
          fallback: imagen(),
          cache,
        })
      : imagen();

  let generator: ImageGeneratorPort;
  if (selected === "procedural") generator = procedural;
  else if (selected === "firefly") generator = firefly();
  else if (selected && selected.includes("/")) generator = openRouter(selected);
  else generator = imagen(); // "auto" / "imagen" / unset → default chain

  return new AssetReusingImageGenerator(generator);
}

/**
 * Composition root — the one place that knows concrete adapters. Wires them into
 * the use case via constructor injection; everything above depends only on ports.
 * `planInput` carries the brief's approved copy pool (resolved by `runCampaign`).
 */
export function buildPipeline(imageModel?: string, planInput: PlanInput = {}): GenerateCampaignUseCase {
  return new GenerateCampaignUseCase({
    imageGenerator: imageGenerator(imageModel),
    proceduralGenerator: new ProceduralBackgroundGenerator(),
    planner: pooledPlanner(planInput),
    compositor: new NodeCanvasCompositor(process.env.MESSAGE_FONT),
    compliance: new BrandComplianceChecker(),
    exporter: new FileSystemExporter(outputRoot()),
    now: () => new Date(),
  });
}

/**
 * Run a campaign. `imageModel` (from `?model=`) selects *which* provider; the
 * `genai` axis decides *whether* GenAI is used for a cell.
 * `regenerateOnly` (the HITL re-roll) restricts the run to just those
 * creatives, leaving every other cell untouched. `expectedPolicyHash` (the
 * persisted report's hash, passed with a variation re-roll) refuses the run
 * when the freshly planned hash differs — the pool or policy changed since the
 * last run, so a single re-rolled slot would be overlaid onto a different base
 * plan; the caller must run the full campaign instead.
 */
export async function runCampaign(
  brief: CampaignBrief,
  imageModel?: string,
  regenerateOnly?: ReadonlyArray<RegenerationTarget>,
  expectedPolicyHash?: string,
): Promise<Result<PipelineResult, Error>> {
  const planInput = await planInputFor(brief);
  if (!planInput.success) return planInput;
  if (expectedPolicyHash !== undefined) {
    const planned = pooledPlanner(planInput.value).plan(brief);
    if (!planned.success) return planned;
    if (planned.value.policyHash !== expectedPolicyHash) {
      return err(
        new Error(
          `Plan changed since the last run (policyHash ${expectedPolicyHash} ≠ ${planned.value.policyHash}); run the full campaign.`,
        ),
      );
    }
  }
  return buildPipeline(imageModel, planInput.value).execute(brief, regenerateOnly ? { regenerateOnly } : undefined);
}

/**
 * Copy-pool generator. Absent when OPENROUTER_API_KEY is unset — routes map that
 * to 503. `OPENROUTER_COPY_MODEL` overrides the adapter's default text model.
 * Never wired into GenerateCampaignUseCase (pools are built up front).
 */
export function copyGenerator(): CopyGeneratorPort | undefined {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return undefined;
  return new OpenRouterCopyGenerator({ apiKey, model: process.env.OPENROUTER_COPY_MODEL });
}
