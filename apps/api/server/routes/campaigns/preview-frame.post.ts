import { createHash } from "node:crypto";
import {
  ANCHOR_VALUES,
  DISPLAY_SIZE_VALUES,
  LAYOUT_VALUES,
  MAX_DURATION_SEC,
  MIN_DURATION_SEC,
  MOTION_KINDS,
  PreviewCreativeFrameUseCase,
  RATIO_VALUES,
  TONE_VALUES,
  type AspectRatioValue,
  type CampaignBrief,
  type DisplaySize,
  type MotionKind,
  type PreviewCellSelection,
  type PreviewFrameCacheEntry,
} from "@campaignfoundry/CampaignOrchestration";
import { errorMessage } from "@campaignfoundry/shared";
import {
  CanvasFfmpegVideoCompositor,
  FileSystemSceneAssetResolver,
  NodeCanvasCompositor,
  ProceduralBackgroundGenerator,
} from "@campaignfoundry/CreativeGeneration";
import { parseBrief } from "../../lib/load-brief.js";
import { BriefRefNotFoundError, resolveBriefAssetRefs } from "../../lib/brief-asset-refs.js";
import { inputAssets } from "../../lib/pipeline.js";
import { LruCache } from "../../lib/preview-cache.js";
import { platformZones } from "../../lib/platform-zones.js";
import { getBriefStore } from "../../lib/ports/index.js";
import { runEnvironment, type RunEnvironment } from "../../lib/run-environment.js";
import { requestTenant } from "../../lib/tenant.js";

/**
 * POST /campaigns/preview-frame — render ONE preview frame from the REAL
 * compositor at the requested ratio (D52): the editor's dock and review figure
 * composite through the same pipeline a run would, instead of approximating the
 * layout in the hand-maintained SVG twin.
 *
 * Body is an envelope `{ brief, cell }` — a structurally valid brief (parsed via
 * `parseBrief`, the one chokepoint) plus one cell selection `{ productId, canvas,
 * layout, tone, anchor? }` whose canvas is a social `{ ratio }` or a display
 * `{ size }`. The answer is `image/png` bytes with the frame's
 * cache key in `x-preview-frame-cache-key`.
 *
 * CREDIT SAFETY (D52): the generator below is `ProceduralBackgroundGenerator`
 * wired DIRECTLY — never the production chain (`auto → Imagen → OpenRouter`).
 * With credentials present, the chain would spend real credits per keystroke;
 * the procedural adapter is offline, deterministic, credit-free. A test proves
 * no other generator is reachable from this wiring.
 *
 * Cache: the use case fingerprints the FULL composite request — the background
 * entering as a content hash of its bytes, never object identity — and consults
 * a small in-memory LRU before compositing. The key travels to the client in the
 * response header.
 *
 * PT-5c2: `brief.id` must name a known campaign (`campaignMeta` defined on
 * both backends) or the answer is 404 — a hidden and a missing campaign
 * identically, and nothing is rendered for either.
 */

/** Bound on the in-memory frame cache — a few editor sessions' worth of cells. */
export const PREVIEW_FRAME_CACHE_ENTRIES = 32;

/** The preview's background source, wired directly (D52 credit safety). Exported for the wiring test. */
export const previewBackgroundGenerator = new ProceduralBackgroundGenerator();
const sha256 = (input: string | Uint8Array): string =>
  createHash("sha256").update(input).digest("hex");

/** The adapters one environment's previews render with (PT-0b2). */
export interface PreviewAdapters {
  readonly compositor: NodeCanvasCompositor;
  readonly videoCompositor: CanvasFfmpegVideoCompositor;
  readonly sceneAssets: FileSystemSceneAssetResolver;
  readonly frameCache: LruCache<PreviewFrameCacheEntry>;
  readonly useCase: PreviewCreativeFrameUseCase;
}

const bundles = new Map<string, PreviewAdapters>();

/**
 * The preview's adapters for a run environment, built from the composition root
 * (D167), never from the process environment at import. One bundle per font,
 * tenant and asset root, and each bundle has its own frame cache: a preview reads
 * the logo from its asset root, so two orgs sending identical inputs would
 * otherwise be served each other's cached frame, the other org's logo included.
 * The font is the validated `messageFont` (D59), the same one the pipeline renders
 * with; the tenant is the environment's own, and the asset root stays in the key
 * beside it (PT-4c) — two roots under ONE tenant are still two asset trees, so
 * dropping it would re-open the #576 class this cache key was widened to close.
 */
export function previewAdapters(env: RunEnvironment): PreviewAdapters {
  // Under s3 `assetRoot` is a pure function of the org (scopeRoots), so it stays
  // in the key rather than being dropped: fs still has two roots per tenant.
  const key = `${env.messageFont}\0${env.tenant.orgId}\0${env.assetRoot}`;
  let bundle = bundles.get(key);
  if (!bundle) {
    // No `{ memo: true }` here, unlike `buildPipeline` (PT-4d): this bundle is
    // kept for the process, so a memo inside it would outlive the upload a
    // preview is waiting on. The frame cache is already keyed on the logoPath
    // string, so an unchanged ref costs nothing anyway.
    const inputs = inputAssets(env);
    const compositor = new NodeCanvasCompositor(env.messageFont, inputs);
    const videoCompositor = new CanvasFfmpegVideoCompositor({
      fontFamily: env.messageFont,
      inputs,
    });
    // VE5b2: a beat's own scene is a reused uploaded asset, never a GenAI call, so
    // wiring the real resolver here carries none of D52's credit-safety concern.
    const sceneAssets = new FileSystemSceneAssetResolver(inputs);
    const frameCache = new LruCache<PreviewFrameCacheEntry>(PREVIEW_FRAME_CACHE_ENTRIES);
    const useCase = new PreviewCreativeFrameUseCase({
      imageGenerator: previewBackgroundGenerator,
      compositor,
      videoCompositor,
      sceneAssets,
      hash: sha256,
      platformSafeZones: platformZones,
      frameCache,
    });
    bundle = { compositor, videoCompositor, sceneAssets, frameCache, useCase };
    bundles.set(key, bundle);
  }
  return bundle;
}

/** Test seam: drop every bundle and its frame cache. */
export function resetPreviewAdapters(): void {
  bundles.clear();
}

/** An envelope `{ brief, cell }` — the only body shape this route accepts. */
const isEnvelope = (value: unknown): value is { brief: unknown; cell: unknown } =>
  typeof value === "object" && value !== null && "brief" in value && "cell" in value;

/**
 * Structurally validate the untrusted cell selection so the use case receives
 * what its types promise — the vocabulary check happens here, at the boundary,
 * not by casting and hoping.
 */
function parsePreviewCell(value: unknown): PreviewCellSelection {
  if (typeof value !== "object" || value === null) {
    throw new Error("Preview cell must be an object.");
  }
  const cell = value as Record<string, unknown>;
  const { productId, canvas, layout, tone, anchor, motion, durationSec, atSec } = cell;
  if (typeof productId !== "string") {
    throw new Error('Preview cell requires a string "productId".');
  }
  if (typeof canvas !== "object" || canvas === null) {
    throw new Error('Preview cell requires a "canvas" of { ratio } or { size }.');
  }
  const spec = canvas as Record<string, unknown>;
  const hasRatio = typeof spec.ratio === "string";
  const hasSize = typeof spec.size === "string";
  if (hasRatio === hasSize) {
    throw new Error("Preview cell canvas must carry exactly one of ratio/size.");
  }
  if (hasRatio && !(RATIO_VALUES as readonly string[]).includes(spec.ratio as string)) {
    throw new Error(`Preview cell canvas ratio must be one of ${RATIO_VALUES.join(", ")}.`);
  }
  if (hasSize && !(DISPLAY_SIZE_VALUES as readonly string[]).includes(spec.size as string)) {
    throw new Error(`Preview cell canvas size must be one of ${DISPLAY_SIZE_VALUES.join(", ")}.`);
  }
  if (typeof layout !== "string" || !(LAYOUT_VALUES as readonly string[]).includes(layout)) {
    throw new Error(`Preview cell layout must be one of ${LAYOUT_VALUES.join(", ")}.`);
  }
  if (typeof tone !== "string" || !(TONE_VALUES as readonly string[]).includes(tone)) {
    throw new Error(`Preview cell tone must be one of ${TONE_VALUES.join(", ")}.`);
  }
  if (
    anchor !== undefined &&
    (typeof anchor !== "string" || !(ANCHOR_VALUES as readonly string[]).includes(anchor))
  ) {
    throw new Error(`Preview cell anchor must be one of ${ANCHOR_VALUES.join(", ")}.`);
  }
  const hasMotion = motion !== undefined;
  const hasDuration = durationSec !== undefined;
  const hasAtSec = atSec !== undefined;
  if ((hasMotion || hasDuration || hasAtSec) && !(hasMotion && hasDuration && hasAtSec)) {
    throw new Error(
      "Preview cell must carry motion, durationSec and atSec together or not at all.",
    );
  }
  if (hasMotion) {
    if (typeof motion !== "string" || !(MOTION_KINDS as readonly string[]).includes(motion)) {
      throw new Error(`Preview cell motion must be one of ${MOTION_KINDS.join(", ")}.`);
    }
    if (
      typeof durationSec !== "number" ||
      !Number.isFinite(durationSec) ||
      durationSec < MIN_DURATION_SEC ||
      durationSec > MAX_DURATION_SEC
    ) {
      throw new Error(
        `Preview cell durationSec must be a finite number in [${MIN_DURATION_SEC}, ${MAX_DURATION_SEC}].`,
      );
    }
    if (typeof atSec !== "number" || !Number.isFinite(atSec) || atSec < 0 || atSec > durationSec) {
      throw new Error(`Preview cell atSec must be a finite number in [0, ${durationSec}].`);
    }
  }
  return {
    productId,
    canvas: hasRatio
      ? { ratio: spec.ratio as AspectRatioValue }
      : { size: spec.size as DisplaySize },
    layout: layout as PreviewCellSelection["layout"],
    tone: tone as PreviewCellSelection["tone"],
    ...(anchor !== undefined ? { anchor: anchor as PreviewCellSelection["anchor"] } : {}),
    ...(hasMotion
      ? {
          motion: motion as MotionKind,
          durationSec: durationSec as number,
          atSec: atSec as number,
        }
      : {}),
  };
}

export default defineEventHandler(async (event) => {
  let brief: CampaignBrief;
  let selection: PreviewCellSelection;
  try {
    const body: unknown = await readBody(event);
    if (!isEnvelope(body)) {
      throw new Error("Preview frame body must be an envelope { brief, cell }.");
    }
    brief = parseBrief(body.brief);
    selection = parsePreviewCell(body.cell);
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: errorMessage(error) };
  }

  // The environment is read inside its own guard, as the generate route does: an
  // unreadable .env is a controlled 500, not a framework error (review on #576).
  let env: RunEnvironment;
  try {
    env = runEnvironment(requestTenant(event));
  } catch {
    setResponseStatus(event, 500);
    return { error: "Could not read the run environment." };
  }
  // PT-5c2: the campaign must be known — see `generate.post.ts`'s identical
  // gate. Previously this route had no check at all; a hidden and a missing
  // campaign now answer the identical 404, and nothing is rendered for either.
  if ((await getBriefStore(env).campaignMeta(brief.id)) === undefined) {
    setResponseStatus(event, 404);
    return { error: `Campaign "${brief.id}" not found.` };
  }
  // PT-4k2a (D208 B, D210 a/d): the gate above answers for the brief's OWN campaign,
  // and this route renders whatever the body names, refs included — so a body brief
  // naming another team's (D210 d) or another org's asset gets that campaign's frame.
  //
  // **BEFORE `useCase.execute`, which is where the frame cache is consulted** — and that
  // is the whole of the hazard: the bundle and its cache are keyed per ORG, not per team
  // (`previewAdapters`), so team B posting team A's body gets a 404 here where a check
  // after the lookup would have answered A's cached PNG, A's logo composited in.
  //
  // The brief handed on is the body's own, byte for byte: the cache keys on the ref
  // STRING and fingerprints the composite, so rewriting it here would move every cache
  // key this route has ever emitted. Check only (D210 a); the remap is PT-4k2b.
  try {
    await resolveBriefAssetRefs(env, brief, { target: brief.id, mode: "render" });
  } catch (error) {
    if (error instanceof BriefRefNotFoundError) {
      setResponseStatus(event, 404);
      return { error: `Campaign "${brief.id}" not found.` };
    }
    throw error;
  }
  const result = await previewAdapters(env).useCase.execute(brief, selection);
  if (!result.success) {
    // A cell the brief cannot render (unknown product, bad ratio) is the caller's error.
    setResponseStatus(event, 400);
    return { error: errorMessage(result.error) };
  }
  setHeader(event, "content-type", "image/png");
  setHeader(event, "x-preview-frame-cache-key", result.value.cacheKey);
  return Buffer.from(result.value.image);
});
