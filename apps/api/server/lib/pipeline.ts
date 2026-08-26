import { join } from "node:path";
import { loadEnv } from "./env.js";
import {
  GenerateCampaignUseCase,
  PlanVariationsUseCase,
  type CampaignBrief,
  type CopyGeneratorPort,
  type ImageGeneratorPort,
  type PipelineResult,
  type PlatformSafeZoneResolver,
  type RegenerationTarget,
} from "@campaignfoundry/CampaignOrchestration";
import {
  AssetReusingImageGenerator,
  CanvasFfmpegVideoCompositor,
  FileSystemBackgroundCache,
  FireflyImageGenerator,
  GeminiImageGenerator,
  NodeCanvasCompositor,
  OpenRouterCopyGenerator,
  OpenRouterImageGenerator,
  ProceduralBackgroundGenerator,
} from "@campaignfoundry/CreativeGeneration";
import { BrandComplianceChecker } from "@campaignfoundry/GovernanceAndCompliance";
import { FileSystemExporter, platformProfile } from "@campaignfoundry/Distribution";
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
 */
export function buildPipeline(imageModel?: string): GenerateCampaignUseCase {
  return new GenerateCampaignUseCase({
    imageGenerator: imageGenerator(imageModel),
    proceduralGenerator: new ProceduralBackgroundGenerator(),
    planner: new PlanVariationsUseCase(platformZones),
    compositor: new NodeCanvasCompositor(process.env.MESSAGE_FONT),
    // Motion variants only; the parser has already gated them on the ffmpeg probe.
    videoCompositor: new CanvasFfmpegVideoCompositor({ fontFamily: process.env.MESSAGE_FONT }),
    compliance: new BrandComplianceChecker(),
    exporter: new FileSystemExporter(outputRoot()),
    now: () => new Date(),
    // D11: safe insets come from Distribution's profile table; orchestration only sees a resolver.
    platformSafeZones: platformZones,
  });
}

/**
 * Distribution's profile table as orchestration sees it: the generator reads the
 * safe insets (D11), the planner the ratio + formats (motion draws only where a
 * requested platform can package a clip).
 */
export const platformZones: PlatformSafeZoneResolver = (platformId) => {
  const profile = platformProfile(platformId);
  return profile ? { ratio: profile.ratio, safeInsets: profile.safeInsets, formats: profile.formats } : undefined;
};

/**
 * Run a campaign. `imageModel` (from `?model=`) selects *which* provider; the
 * `genai` axis decides *whether* GenAI is used for a cell.
 * `regenerateOnly` (the HITL re-roll) restricts the run to just those
 * creatives, leaving every other cell untouched.
 */
export function runCampaign(
  brief: CampaignBrief,
  imageModel?: string,
  regenerateOnly?: ReadonlyArray<RegenerationTarget>,
): Promise<Result<PipelineResult, Error>> {
  return buildPipeline(imageModel).execute(brief, regenerateOnly ? { regenerateOnly } : undefined);
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
