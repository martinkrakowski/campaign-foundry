import { join } from "node:path";
import {
  GenerateCampaignUseCase,
  type BackgroundCachePort,
  type CampaignBrief,
  type CopyGeneratorPort,
  type ExportPort,
  type ImageGeneratorPort,
  type InputAssetPort,
  type PipelineResult,
  type PlanInput,
  type RegenerationTarget,
} from "@campaignfoundry/CampaignOrchestration";
import {
  AssetReusingImageGenerator,
  CanvasFfmpegVideoCompositor,
  FileSystemAudioAssetResolver,
  FileSystemBackgroundCache,
  FileSystemInputAssets,
  FileSystemSceneAssetResolver,
  FireflyImageGenerator,
  GeminiImageGenerator,
  NodeCanvasCompositor,
  ObjectBackgroundCache,
  OpenRouterCopyGenerator,
  OpenRouterImageGenerator,
  ProceduralBackgroundGenerator,
} from "@campaignfoundry/CreativeGeneration";
import { BrandComplianceChecker } from "@campaignfoundry/GovernanceAndCompliance";
import { FileSystemExporter, ObjectExporter } from "@campaignfoundry/Distribution";
import { err, type Result } from "@campaignfoundry/shared";
import { objectStore } from "./config.js";
// `./object-store/object-input-assets.js` DIRECTLY, never the `object-store`
// barrel: this class imports the ports barrel for `getAssetStore`, and the barrel
// imports `object-store/index.js`, so a re-export there would close a cycle. See
// that file's "Must not".
import { ObjectInputAssets } from "./object-store/object-input-assets.js";
// The barrel itself, for `objectStoreClient()` — the same module the input-asset
// route reaches, so a run's inputs and renders go through ONE store instance.
import { objectStoreClient } from "./object-store/index.js";
import { cachePrefix, renderPrefix } from "./object-store/object-keys.js";
// `./render-target.js` directly, for the same reason as `ObjectInputAssets` above:
// it imports `database()`, and the barrel is not where the composition root's
// callers should be reaching from.
import { renderTarget, type RenderTarget } from "./object-store/render-target.js";
import type { Provider } from "./ports/provider-key.port.js";
import type { ProviderSettings, RunEnvironment } from "./run-environment.js";
import { MeteredCopyGenerator, MeteredImageGenerator } from "./metering.js";
import { getUsageStore } from "./ports/index.js";
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
 * Each adapter's default model id, for the usage row a metered call records
 * (PT-7a, D175): `BackgroundResult` carries no model id, and the adapters
 * don't expose the one they resolved to publicly, so this mirrors the
 * default each one falls back to when its own `model` option is unset. Kept
 * in sync here the same way `ALLOWED_IMAGE_MODELS` above is kept in sync with
 * the UI catalog — a parallel constant, not a shared import, because the
 * adapters live in `packages/*` and metering must not (D167).
 */
const IMAGEN_DEFAULT_MODEL = "imagen-4.0-generate-001";
const OPENROUTER_IMAGE_DEFAULT_MODEL = "x-ai/grok-imagine-image-quality";
/** Firefly v3 generate has no model option to override. */
const FIREFLY_MODEL = "v3";

/** `model` if set, else `fallback` — the same "unset or empty → default" rule each adapter applies internally. */
function resolvedModel(model: string | undefined, fallback: string): string {
  return model && model.length > 0 ? model : fallback;
}

export interface InputAssetsOptions {
  /**
   * Cache successful reads inside the returned port, so a run reads one asset
   * once. Opt-in, and only {@link buildPipeline} opts in.
   *
   * It is opt-in rather than always-on because the reader's lifetime is the
   * caller's choice: a run's reader dies with the run, while `imageGenerator`'s
   * default and the preview bundle are kept by their callers — the preview's
   * bundles live for the process (one per font, org and asset root), and a
   * process-lifetime memo there would serve stale bytes for the whole preview
   * session. Ignored under `fs`, where `FileSystemInputAssets` is exactly as
   * memo-free as it has always been.
   */
  readonly memo?: boolean;
}

/**
 * The run's reader for brief-supplied input assets (PT-4c): one port over this
 * environment's asset root, for the reused product images, the compositor's logo,
 * a beat's scene and the music bed.
 *
 * Built from `env` per call and never from the process environment (D167), so a
 * tenant's runs read that tenant's assets. It is deliberately the only place an
 * `InputAssetPort` is constructed: substituting the storage backend means
 * changing this function, not the five consumers behind it.
 *
 * **The switch is `objectStore()`, and it is here and nowhere else** (PT-4d):
 * under `s3` an `ObjectInputAssets` reads a brief's ref through PT-4b's org-scoped
 * `ObjectAssetStore`, and under `fs` it is today's `FileSystemInputAssets` over
 * `env.assetRoot`, unchanged. Every path that renders a creative — the generate
 * route, the in-API Kafka consumer, `bin/worker.ts`, `bin/generate.ts`, the
 * preview route — reaches this function, so there is no second place to change
 * and no path that can silently stay on disk.
 *
 * `buildPipeline` calls this ONCE and hands the result to every consumer, so a
 * run reads one tree through one reader. A caller that wants a pipeline reader
 * must pass that same instance on (see {@link imageGenerator}'s `inputs`); a
 * standalone call gets its own, which is why this function promises one port per
 * call and not one per run.
 */
export function inputAssets(env: RunEnvironment, options: InputAssetsOptions = {}): InputAssetPort {
  if (objectStore() === "s3") return new ObjectInputAssets(env, options);
  return new FileSystemInputAssets(env.assetRoot);
}

/**
 * Where this environment's GenAI background cache lives (PT-4e), and the second
 * half of the switch `inputAssets` above is one of: under `s3` a `PNG` cache
 * under the org's prefix in the bucket, under `fs` today's `<outputRoot>/cache`.
 *
 * It is here, next to the reader, for the reason that switch is here: this is
 * the composition root's single list of which concrete adapter each port gets on
 * each backend, and every path that generates a creative comes through it.
 *
 * The prefix is the ORG's, never the process's and never the campaign's (D203):
 * a cache entry belongs to the prompt that produced it, which belongs to the
 * tenant, and keying it by campaign would mean a re-run under a different
 * campaign regenerated an image it had already paid for.
 */
function backgroundCache(env: RunEnvironment): BackgroundCachePort {
  if (objectStore() === "s3") {
    return new ObjectBackgroundCache(objectStoreClient(), cachePrefix(env.tenant.orgId));
  }
  return new FileSystemBackgroundCache(join(env.outputRoot, "cache"));
}

/**
 * Where this run's renders and proofs go (PT-4e): an `ObjectExporter` over the
 * campaign's uuid prefix under `s3`, `FileSystemExporter` over `outputRoot`
 * under `fs`.
 *
 * **`renders` is required under `s3` and there is no fallback.** A key cannot be
 * built without the campaign uuid (DoD 3), and the two obvious ways to invent
 * one are both worse than failing: using the slug puts a renameable,
 * user-chosen string into the store's namespace, and reaching for the campaign's
 * assets would write one campaign's renders beside another's. A silent fallback
 * to disk is the worst of the three, because a run under `s3` would appear to
 * succeed and its output would live somewhere nothing under `s3` can serve —
 * which is a report whose every link 404s, discovered by an operator rather than
 * by a test. `runCampaign` refuses in `Result` terms first, with a message that
 * names what to do; this throw is the backstop for a caller that reached
 * `buildPipeline` without going through a run.
 */
function exporter(env: RunEnvironment, renders: RenderTarget | undefined): ExportPort {
  if (objectStore() === "fs") return new FileSystemExporter(env.outputRoot);
  if (renders === undefined) {
    throw new Error(
      "Refusing to build a pipeline with no render target: under OBJECT_STORE=s3 renders are keyed by the campaign's uuid, which runCampaign resolves once per run.",
    );
  }
  return new ObjectExporter(objectStoreClient(), {
    prefix: renderPrefix(env.tenant.orgId, renders.campaignId),
    campaignSegment: renders.slug,
  });
}

/**
 * The image provider fallback chain for a given selection (PT-7b3a).
 * - "procedural" -> []
 * - "firefly" -> ["firefly", "gemini", "openrouter"]
 * - slash model -> ["openrouter"]
 * - anything else -> ["gemini", "openrouter"]
 */
export function imageProviderChain(selected?: string): readonly Provider[] {
  if (selected === "procedural") return [];
  if (selected === "firefly") return ["firefly", "gemini", "openrouter"];
  if (selected && selected.includes("/")) return ["openrouter"];
  return ["gemini", "openrouter"];
}

/**
 * The primary image provider is the first member of the chain whose credentials
 * (org or platform) are present (PT-7b3a).
 */
export function primaryImageProvider(
  chain: readonly Provider[],
  platformProviders: ProviderSettings,
  activeProviders?: ReadonlySet<Provider> | readonly Provider[],
): Provider | undefined {
  const active =
    activeProviders === undefined
      ? undefined
      : activeProviders instanceof Set
        ? activeProviders
        : new Set(activeProviders);
  return chain.find((provider) => {
    if (active?.has(provider)) return true;
    switch (provider) {
      case "firefly":
        return Boolean(platformProviders.fireflyClientId && platformProviders.fireflyClientSecret);
      case "gemini":
        return Boolean(platformProviders.geminiKey);
      case "openrouter":
        return Boolean(platformProviders.openRouterKey);
    }
  });
}

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
 *
 * `inputs` is the reader the reuse wrapper reads a product's `inputAsset`
 * through. It defaults to this environment's own, so a standalone call still
 * works, but {@link buildPipeline} passes the reader it already built: a run then
 * reads one asset tree through ONE port instead of a second, identical one built
 * here for the reuse wrapper alone.
 *
 * The background cache below needs no render target (see
 * {@link backgroundCache}), which is why this function takes none — the target is
 * the exporter's input and only the exporter's.
 */
export function imageGenerator(
  env: RunEnvironment,
  selected?: string,
  inputs: InputAssetPort = inputAssets(env),
): ImageGeneratorPort {
  const procedural = new ProceduralBackgroundGenerator();
  const cache = backgroundCache(env);
  const usage = getUsageStore(env);
  const orgId = env.tenant.orgId;
  const {
    geminiKey,
    openRouterKey,
    fireflyClientId: fireflyId,
    fireflyClientSecret: fireflySecret,
    keyOwners,
  } = env.providers;
  const geminiOwner = keyOwners?.gemini ?? "platform";
  const openRouterOwner = keyOwners?.openrouter ?? "platform";
  const fireflyOwner = keyOwners?.firefly ?? "platform";

  // An OpenRouter generator for a given model, falling back to procedural.
  // Metered (PT-7a): every non-cached background it resolves — whether called
  // directly or as another provider's fallback — records one usage row.
  const openRouter = (model?: string): ImageGeneratorPort =>
    openRouterKey
      ? new MeteredImageGenerator(
          new OpenRouterImageGenerator({
            apiKey: openRouterKey,
            model,
            fallback: procedural,
            cache,
          }),
          usage,
          orgId,
          "openrouter",
          resolvedModel(model, OPENROUTER_IMAGE_DEFAULT_MODEL),
          openRouterOwner,
        )
      : procedural;

  // Imagen with the OpenRouter default as its first fallback, then procedural.
  const imagen = (): ImageGeneratorPort =>
    geminiKey
      ? new MeteredImageGenerator(
          new GeminiImageGenerator({
            apiKey: geminiKey,
            model: env.providers.imagenModel,
            fallback: openRouter(env.providers.openRouterImageModel),
            cache,
          }),
          usage,
          orgId,
          "imagen",
          resolvedModel(env.providers.imagenModel, IMAGEN_DEFAULT_MODEL),
          geminiOwner,
        )
      : openRouter(env.providers.openRouterImageModel);

  // Adobe Firefly Services, degrading to the default chain when it's unavailable or
  // its credentials are absent.
  const firefly = (): ImageGeneratorPort =>
    fireflyId && fireflySecret
      ? new MeteredImageGenerator(
          new FireflyImageGenerator({
            clientId: fireflyId,
            clientSecret: fireflySecret,
            fallback: imagen(),
            cache,
          }),
          usage,
          orgId,
          "firefly",
          FIREFLY_MODEL,
          fireflyOwner,
        )
      : imagen();

  const chain = imageProviderChain(selected);
  let generator: ImageGeneratorPort;
  switch (chain[0]) {
    case "firefly":
      generator = firefly();
      break;
    case "gemini":
      generator = imagen();
      break;
    case "openrouter":
      generator = openRouter(selected);
      break;
    default:
      generator = procedural;
      break;
  }

  return new AssetReusingImageGenerator(generator, inputs);
}

/**
 * Composition root — the one place that knows concrete adapters. Wires them into
 * the use case via constructor injection; everything above depends only on ports.
 * `planInput` carries the brief's approved copy pool and the ratios its motion
 * platforms package (both resolved by `runCampaign` via `planInputFor`).
 * `env` is the run's environment, resolved once by the caller (D167): every
 * location, font and credential below comes from it, never from the process environment.
 *
 * `renders` is this run's {@link RenderTarget}, resolved ONCE by `runCampaign`
 * (PT-4e, D207) and handed straight through. It is a parameter rather than a
 * lookup because the lookup is a database query with a tenancy rule attached to
 * it, and a composition root is the worst possible place to be making one per
 * build; under `fs` it is absent and nothing changes. Absent under `s3` it is
 * REFUSED by {@link exporter}, never defaulted.
 */
export function buildPipeline(
  env: RunEnvironment,
  imageModel?: string,
  planInput: PlanInput = {},
  renders?: RenderTarget,
): GenerateCampaignUseCase {
  // One reader for this environment, shared by every consumer below (PT-4c), and
  // the ONLY caller that asks for the per-run memo (PT-4d): the logo is read once
  // per cell, so a 50-cell run asks a bucket for the same object ~150 times
  // without it. Under fs the flag is ignored and this is still one
  // `FileSystemInputAssets` over `env.assetRoot`.
  const inputs = inputAssets(env, { memo: true });
  return new GenerateCampaignUseCase({
    imageGenerator: imageGenerator(env, imageModel, inputs),
    proceduralGenerator: new ProceduralBackgroundGenerator(),
    planner: pooledPlanner(planInput),
    compositor: new NodeCanvasCompositor(env.messageFont, inputs),
    // Motion variants only; the parser has already gated them on the ffmpeg probe.
    videoCompositor: new CanvasFfmpegVideoCompositor({
      fontFamily: env.messageFont,
      inputs,
    }),
    // VE5b2: resolves a timeline beat's own background — motion variants only.
    sceneAssets: new FileSystemSceneAssetResolver(inputs),
    // VE3b2: resolves the brief's music bed (audio.path) — motion variants only.
    audioAssets: new FileSystemAudioAssetResolver(inputs),
    compliance: new BrandComplianceChecker(),
    exporter: exporter(env, renders),
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
  // AFTER the pins above, on purpose: a re-roll refused for a changed plan or a
  // changed copy has answered the caller already, and a query for the campaign
  // row it would never have run is a tenancy decision taken on a run that turned
  // out not to be a run at all (C5).
  const renders = await renderTarget(env, brief.id);
  // The composition-site refusal, and the only message an operator gets. Under
  // `s3` there is no campaign row to key renders by, and the reachable case is
  // the CLI: campaign rows are created through the API, so a hand-written YAML
  // brief run under `OBJECT_STORE=s3` has never had one. `buildPipeline` throws
  // on the same absence as a backstop for a caller that skipped this, and this
  // is here so the CLI — which reports `error.message` and exits 1 — says what
  // to do instead of showing a stack.
  if (objectStore() === "s3" && renders === undefined) {
    return err(
      new Error(
        `Campaign "${brief.id}" has no row in this org; under OBJECT_STORE=s3 a run needs its campaign — save the brief through the API first.`,
      ),
    );
  }
  return buildPipeline(env, imageModel, planInput.value, renders).execute(brief, options);
}

/**
 * Copy-pool generator. Absent when OPENROUTER_API_KEY is unset — routes map that
 * to 503. `OPENROUTER_COPY_MODEL` overrides the adapter's default text model.
 * Never wired into GenerateCampaignUseCase (pools are built up front).
 */
export function copyGenerator(env: RunEnvironment): CopyGeneratorPort | undefined {
  const apiKey = env.providers.openRouterKey;
  if (!apiKey) return undefined;
  const openRouterOwner = env.providers.keyOwners?.openrouter ?? "platform";
  return new MeteredCopyGenerator(
    new OpenRouterCopyGenerator({ apiKey, model: env.providers.openRouterCopyModel }),
    getUsageStore(env),
    env.tenant.orgId,
    "openrouter",
    openRouterOwner,
  );
}
