import { createHash } from "node:crypto";
import {
  ANCHOR_VALUES,
  LAYOUT_VALUES,
  PreviewCreativeFrameUseCase,
  RATIO_VALUES,
  TONE_VALUES,
  type CampaignBrief,
  type PreviewCellSelection,
  type PreviewFrameCacheEntry,
} from "@campaignfoundry/CampaignOrchestration";
import { errorMessage } from "@campaignfoundry/shared";
import { NodeCanvasCompositor, ProceduralBackgroundGenerator } from "@campaignfoundry/CreativeGeneration";
import { parseBrief } from "../../lib/load-brief.js";
import { LruCache } from "../../lib/preview-cache.js";
import { platformZones } from "../../lib/platform-zones.js";

/**
 * POST /campaigns/preview-frame — render ONE preview frame from the REAL
 * compositor at the requested ratio (D52): the editor's dock and review figure
 * composite through the same pipeline a run would, instead of approximating the
 * layout in the hand-maintained SVG twin.
 *
 * Body is an envelope `{ brief, cell }` — a structurally valid brief (parsed via
 * `parseBrief`, the one chokepoint) plus one cell selection `{ productId, ratio,
 * layout, tone, anchor? }`. The answer is `image/png` bytes with the frame's
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
 */

/** Bound on the in-memory frame cache — a few editor sessions' worth of cells. */
export const PREVIEW_FRAME_CACHE_ENTRIES = 32;

/** The preview's background source, wired directly (D52 credit safety). Exported for the wiring test. */
export const previewBackgroundGenerator = new ProceduralBackgroundGenerator();
export const previewCompositor = new NodeCanvasCompositor(process.env.MESSAGE_FONT);
export const previewFrameCache = new LruCache<PreviewFrameCacheEntry>(PREVIEW_FRAME_CACHE_ENTRIES);

const sha256 = (input: string | Uint8Array): string =>
  createHash("sha256").update(input).digest("hex");

const previewUseCase = new PreviewCreativeFrameUseCase({
  imageGenerator: previewBackgroundGenerator,
  compositor: previewCompositor,
  hash: sha256,
  platformSafeZones: platformZones,
  frameCache: previewFrameCache,
});

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
  const { productId, ratio, layout, tone, anchor } = cell;
  if (typeof productId !== "string") {
    throw new Error('Preview cell requires a string "productId".');
  }
  if (typeof ratio !== "string" || !(RATIO_VALUES as readonly string[]).includes(ratio)) {
    throw new Error(`Preview cell ratio must be one of ${RATIO_VALUES.join(", ")}.`);
  }
  if (typeof layout !== "string" || !(LAYOUT_VALUES as readonly string[]).includes(layout)) {
    throw new Error(`Preview cell layout must be one of ${LAYOUT_VALUES.join(", ")}.`);
  }
  if (typeof tone !== "string" || !(TONE_VALUES as readonly string[]).includes(tone)) {
    throw new Error(`Preview cell tone must be one of ${TONE_VALUES.join(", ")}.`);
  }
  if (anchor !== undefined && (typeof anchor !== "string" || !(ANCHOR_VALUES as readonly string[]).includes(anchor))) {
    throw new Error(`Preview cell anchor must be one of ${ANCHOR_VALUES.join(", ")}.`);
  }
  return {
    productId,
    ratio,
    layout: layout as PreviewCellSelection["layout"],
    tone: tone as PreviewCellSelection["tone"],
    ...(anchor !== undefined ? { anchor: anchor as PreviewCellSelection["anchor"] } : {}),
  };
}

export default defineEventHandler(async (event) => {
  let brief: CampaignBrief;
  let selection: PreviewCellSelection;
  try {
    const body: unknown = await readBody(event);
    if (!isEnvelope(body)) {
      throw new Error('Preview frame body must be an envelope { brief, cell }.');
    }
    brief = parseBrief(body.brief);
    selection = parsePreviewCell(body.cell);
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: errorMessage(error) };
  }

  const result = await previewUseCase.execute(brief, selection);
  if (!result.success) {
    // A cell the brief cannot render (unknown product, bad ratio) is the caller's error.
    setResponseStatus(event, 400);
    return { error: errorMessage(result.error) };
  }
  setHeader(event, "content-type", "image/png");
  setHeader(event, "x-preview-frame-cache-key", result.value.cacheKey);
  return Buffer.from(result.value.image);
});
