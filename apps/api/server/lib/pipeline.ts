import { join } from "node:path";
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
  CanvasFfmpegVideoCompositor,
  FileSystemAudioAssetResolver,
  FileSystemBackgroundCache,
  FileSystemSceneAssetResolver,
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
import type { RunEnvironment } from "./run-environment.js";
import { platformZones } from "./platform-zones.js";
import { planInputFor, pooledPlanner } from "./pools.js";

export { platformZones } from "./platform-zones.js";
export { messageFont } from "./run-environment.js";

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
function imageGenerator(env: RunEnvironment, selected?: string): ImageGeneratorPort {
  const procedural = new ProceduralBackgroundGenerator();
  const cache = new FileSystemBackgroundCache(join(env.outputRoot, "cache"));
  const {
    geminiKey,
    openRouterKey,
    fireflyClientId: fireflyId,
    fireflyClientSecret: fireflySecret,
  } = env.providers;

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
          model: env.providers.imagenModel,
          fallback: openRouter(env.providers.openRouterImageModel),
          cache,
        })
      : openRouter(env.providers.openRouterImageModel);

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

  return new AssetReusingImageGenerator(generator, env.assetRoot);
}

/**
 * Composition root — the one place that knows concrete adapters. Wires them into
 * the use case via constructor injection; everything above depends only on ports.
 * `planInput` carries the brief's approved copy pool and the ratios its motion
 * platforms package (both resolved by `runCampaign` via `planInputFor`).
 * `env` is the run's environment, resolved once by the caller (D167): every
 * location, font and credential below comes from it, never from the process environment.
 */
export function buildPipeline(
  env: RunEnvironment,
  imageModel?: string,
  planInput: PlanInput = {},
): GenerateCampaignUseCase {
  return new GenerateCampaignUseCase({
    imageGenerator: imageGenerator(env, imageModel),
    proceduralGenerator: new ProceduralBackgroundGenerator(),
    planner: pooledPlanner(planInput),
    compositor: new NodeCanvasCompositor(env.messageFont, env.assetRoot),
    // Motion variants only; the parser has already gated them on the ffmpeg probe.
    videoCompositor: new CanvasFfmpegVideoCompositor({
      fontFamily: env.messageFont,
      assetRoot: env.assetRoot,
    }),
    // VE5b2: resolves a timeline beat's own background — motion variants only.
    sceneAssets: new FileSystemSceneAssetResolver(env.assetRoot),
    // VE3b2: resolves the brief's music bed (audio.path) — motion variants only.
    audioAssets: new FileSystemAudioAssetResolver(env.assetRoot),
    compliance: new BrandComplianceChecker(),
    exporter: new FileSystemExporter(env.outputRoot),
    now: () => new Date(),
    // D11: safe insets come from Distribution's profile table; orchestration only sees a resolver.
    platformSafeZones: platformZones,
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
 * plan; the caller must run the full campaign instead. `expectedCopyHash` is
 * the same pin over the brief's copy surface (§35) — a disjoint hash, checked
 * independently, so editing the message or a timeline beat and re-rolling one
 * *other* cell is refused too, not just an axis change. Either pin is skipped
 * (no refusal) when its expected value is `undefined`: every report persisted
 * before this hash existed carries no copy hash at all, and refusing those
 * would make every pre-existing campaign un-re-rollable.
 */
export async function runCampaign(
  /** Captured when the run is enqueued (D167), so it keeps its location and keys. */
  env: RunEnvironment,
  brief: CampaignBrief,
  imageModel?: string,
  regenerateOnly?: ReadonlyArray<RegenerationTarget>,
  expectedPolicyHash?: string,
  expectedCopyHash?: string,
  /** The run's deadline (R5, D77), created by `runJob` and threaded to every image adapter. */
  signal?: AbortSignal,
  /** Per-cell progress sink; the route writes it onto the job the poller reads. */
  onProgress?: (done: number, total: number) => void,
): Promise<Result<PipelineResult, Error>> {
  const planInput = await planInputFor(env, brief);
  if (!planInput.success) return planInput;
  if (expectedPolicyHash !== undefined || expectedCopyHash !== undefined) {
    const planned = pooledPlanner(planInput.value).plan(brief);
    if (!planned.success) return planned;
    if (expectedPolicyHash !== undefined && planned.value.policyHash !== expectedPolicyHash) {
      return err(
        new Error(
          `Plan changed since the last run (policyHash ${expectedPolicyHash} ≠ ${planned.value.policyHash}); run the full campaign.`,
        ),
      );
    }
    if (expectedCopyHash !== undefined && planned.value.copyHash !== expectedCopyHash) {
      return err(
        new Error(
          `The brief's copy changed since the last run (copyHash ${expectedCopyHash} ≠ ${planned.value.copyHash}); run the full campaign.`,
        ),
      );
    }
  }
  // Options are built from whichever of the three is present: a re-roll with no
  // deadline (the CLI) and a full run with one are both legitimate, and a run
  // with nobody listening for progress is the CLI again.
  const options =
    regenerateOnly === undefined && signal === undefined && onProgress === undefined
      ? undefined
      : {
          ...(regenerateOnly ? { regenerateOnly } : {}),
          ...(signal ? { signal } : {}),
          ...(onProgress ? { onProgress } : {}),
        };
  return buildPipeline(env, imageModel, planInput.value).execute(brief, options);
}

/**
 * Copy-pool generator. Absent when OPENROUTER_API_KEY is unset — routes map that
 * to 503. `OPENROUTER_COPY_MODEL` overrides the adapter's default text model.
 * Never wired into GenerateCampaignUseCase (pools are built up front).
 */
export function copyGenerator(env: RunEnvironment): CopyGeneratorPort | undefined {
  const apiKey = env.providers.openRouterKey;
  if (!apiKey) return undefined;
  return new OpenRouterCopyGenerator({ apiKey, model: env.providers.openRouterCopyModel });
}
