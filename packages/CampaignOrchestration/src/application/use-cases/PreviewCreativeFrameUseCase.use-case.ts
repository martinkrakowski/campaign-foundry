import { err, ok, type Result } from "@campaignfoundry/shared";
import type { CampaignBrief } from "../../domain/entities/CampaignBrief.js";
import type { Product } from "../../domain/entities/Product.js";
import { AspectRatio } from "../../domain/value-objects/AspectRatio.vo.js";
import type { AspectRatioValue } from "../../domain/value-objects/aspect-ratios.js";
import type { BackgroundSource } from "../../domain/value-objects/BackgroundSource.vo.js";
import type { LayoutKind, ToneKind } from "../../domain/value-objects/Treatment.vo.js";
import type { AnchorKind } from "../../domain/value-objects/variation-defaults.js";
import type { CompositeRequest, CompositorPort } from "../ports/out/CompositorPort.js";
import type { BackgroundContext, ImageGeneratorPort } from "../ports/out/ImageGeneratorPort.js";
import type { PlatformSafeZoneResolver } from "../ports/out/PlatformProfilePort.js";
import { unionSafeInsets } from "./GenerateCampaignUseCase.use-case.js";

/**
 * One cell of the campaign, picked by the editor: the same look a planned
 * variant would carry, but selected directly instead of drawn from a plan —
 * the preview answers "what would this cell render" before any run exists.
 */
export interface PreviewCellSelection {
  readonly productId: string;
  readonly ratio: string;
  readonly layout: LayoutKind;
  readonly tone: ToneKind;
  /** Absent → the compositor derives from layout, exactly as the run does. */
  readonly anchor?: AnchorKind;
}

/** One composited preview frame: the PNG bytes, their content identity, provenance. */
export interface PreviewCreativeFrame {
  readonly image: Uint8Array;
  /**
   * The composite request's content fingerprint — stable across processes,
   * carried in the response header so the client can identify the frame.
   */
  readonly cacheKey: string;
  readonly logoApplied: boolean;
  readonly ratio: AspectRatioValue;
  readonly backgroundSource: BackgroundSource;
}

/** A cached composite — the bytes plus the logo verdict the compliance signal needs. */
export interface PreviewFrameCacheEntry {
  readonly image: Uint8Array;
  readonly logoApplied: boolean;
}

/**
 * Cache seam — an in-memory LRU at the composition root. Keyed by the frame's
 * content fingerprint, so a hit is the same bytes a re-composite would draw.
 */
export interface PreviewFrameCache {
  get(key: string): PreviewFrameCacheEntry | undefined;
  set(key: string, entry: PreviewFrameCacheEntry): void;
}

/**
 * Hash seam — node:crypto at the composition root (application stays off node
 * builtins, the same split as `PolicyHasher`/`NodeCryptoPolicyHasher`).
 */
export type FrameFingerprintHash = (input: string | Uint8Array) => string;

/** Ports injected at the composition root — the use case depends on contracts, never adapters. */
export interface PreviewCreativeFrameDeps {
  readonly imageGenerator: ImageGeneratorPort;
  readonly compositor: CompositorPort;
  readonly hash: FrameFingerprintHash;
  /** Safe-inset source for `output.platforms` (D11). Absent → no insets are ever passed. */
  readonly platformSafeZones?: PlatformSafeZoneResolver;
  readonly frameCache?: PreviewFrameCache;
}

/**
 * The preview frame's cache key: a stable hash of EVERY `CompositeRequest`
 * field, with the background entering as a content hash of its bytes — never
 * object identity, never an unspecified serialisation. Two requests that
 * differ only in background bytes can never collide; two identical requests
 * hash equal everywhere (D52).
 */
export function compositeRequestFingerprint(
  request: CompositeRequest,
  hash: FrameFingerprintHash,
): string {
  return hash(
    JSON.stringify({
      background: hash(request.background),
      message: request.message,
      brandColor: request.brandColor,
      logoPath: request.logoPath,
      ratio: request.ratio.value,
      layout: request.layout,
      tone: request.tone,
      ...(request.anchor !== undefined ? { anchor: request.anchor } : {}),
      ...(request.safeInsets !== undefined ? { safeInsets: request.safeInsets } : {}),
    }),
  );
}

/**
 * PreviewCreativeFrameUseCase — render ONE frame from the real compositor at the
 * requested ratio, so the editor's preview reflects the layout exactly instead of
 * approximating it in a hand-maintained SVG twin (D52).
 *
 * The request is built the way `GenerateCampaignUseCase.renderVariant` builds it —
 * the same localized-message fallback, the same background context, the same
 * safe-inset union (D11), the same conditional anchor — because a preview that
 * composes differently from the run is the D26 fabrication failure in a new coat.
 * The generator is whatever the composition root injects; the preview route wires
 * `ProceduralBackgroundGenerator` DIRECTLY (never the production chain), keeping
 * every preview credit-free.
 */
export class PreviewCreativeFrameUseCase {
  constructor(private readonly deps: PreviewCreativeFrameDeps) {}

  async execute(
    brief: CampaignBrief,
    selection: PreviewCellSelection,
  ): Promise<Result<PreviewCreativeFrame, Error>> {
    // The cell must name a product this brief actually carries.
    const product = brief.products.find((candidate) => candidate.id === selection.productId);
    if (product === undefined) {
      return err(new Error(`Preview cell references unknown product "${selection.productId}".`));
    }
    const ratio = AspectRatio.create(selection.ratio);
    if (!ratio.success) return ratio;

    const { request, backgroundSource } = await this.buildCompositeRequest(
      brief,
      selection,
      product,
      ratio.value,
    );
    const cacheKey = compositeRequestFingerprint(request, this.deps.hash);
    const cached = this.deps.frameCache?.get(cacheKey);
    if (cached !== undefined) {
      return ok({
        image: cached.image,
        cacheKey,
        logoApplied: cached.logoApplied,
        ratio: ratio.value.value,
        backgroundSource,
      });
    }

    const composite = await this.deps.compositor.compositeAsset(request);
    this.deps.frameCache?.set(cacheKey, { image: composite.image, logoApplied: composite.logoApplied });
    return ok({
      image: composite.image,
      cacheKey,
      logoApplied: composite.logoApplied,
      ratio: ratio.value.value,
      backgroundSource,
    });
  }

  /** The exact request the run would build for this cell — no forked math. */
  private async buildCompositeRequest(
    brief: CampaignBrief,
    selection: PreviewCellSelection,
    product: Product,
    ratio: AspectRatio,
  ): Promise<{ request: CompositeRequest; backgroundSource: BackgroundSource }> {
    // LocalizedMessageFallback — the use case resolves the copy, never the caller.
    const copy = brief.localizedMessage ?? brief.campaignMessage;
    const context: BackgroundContext = {
      campaignMessage: brief.campaignMessage,
      targetAudience: brief.targetAudience,
      targetRegion: brief.targetRegion,
    };
    const background = await this.deps.imageGenerator.resolveBackground(product, ratio, context);
    // D11: the same per-ratio union of the requested platforms' safe insets the run passes.
    const safeInsets = unionSafeInsets(brief.output?.platforms, this.deps.platformSafeZones).get(
      ratio.value,
    );
    const request: CompositeRequest = {
      background: background.image,
      message: copy,
      brandColor: product.primaryColor,
      logoPath: product.logoPath,
      ratio,
      layout: selection.layout,
      tone: selection.tone,
      // Absent → the compositor derives from layout, byte-identical to the pre-axis path.
      ...(selection.anchor !== undefined ? { anchor: selection.anchor } : {}),
      // The template's type block rides the frame exactly as it rides the run
      // (GenerateCampaignUseCase:261) — a preview that ignores it is D45's failure.
      ...(brief.style !== undefined ? { style: brief.style } : {}),
      ...(safeInsets !== undefined ? { safeInsets } : {}),
    };
    return { request, backgroundSource: background.source };
  }
}
