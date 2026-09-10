import { err, ok, type Result } from "@campaignfoundry/shared";
import type { CampaignBrief } from "../../domain/entities/CampaignBrief.js";
import type { Product } from "../../domain/entities/Product.js";
import { AspectRatio } from "../../domain/value-objects/AspectRatio.vo.js";
import {
  nearestSocialRatio,
  type AspectRatioValue,
  type CanvasSpec,
} from "../../domain/value-objects/aspect-ratios.js";
import { DISPLAY_SIZE_VALUES, type DisplaySize } from "../../domain/value-objects/display-sizes.js";
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
  /** The cell's canvas: a social `{ ratio }` or a display `{ size }` — never both. */
  readonly canvas: CanvasSpec;
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
  /** The canvas the frame was composited at, exactly as requested. */
  readonly canvas: CanvasSpec;
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

/** Social fingerprints keep the `ratio` key so style-less hashes stay put. */
function canvasFingerprint(spec: CanvasSpec): { readonly ratio: AspectRatioValue } | { readonly size: DisplaySize } {
  const exclusive = spec as { readonly ratio: AspectRatioValue } | { readonly size: DisplaySize };
  if ("ratio" in exclusive) return { ratio: exclusive.ratio };
  return { size: exclusive.size };
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
      ...canvasFingerprint(request.canvas),
      layout: request.layout,
      tone: request.tone,
      ...(request.anchor !== undefined ? { anchor: request.anchor } : {}),
      ...(request.style !== undefined ? { style: request.style } : {}),
      ...(request.safeInsets !== undefined ? { safeInsets: request.safeInsets } : {}),
      ...(request.pixelSize !== undefined ? { pixelSize: request.pixelSize } : {}),
      // The brief's template (D120/D123, C3): a reordered template must not
      // share a cache key with the canonical order it replaced (mutation:
      // drop this line and the new "template alone moves the key" test goes
      // red).
      ...(request.template !== undefined ? { template: request.template } : {}),
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
    // The canvas is exactly one family: a dual-key (or empty) spec is the
    // caller's error, refused before any port is called — the same guard
    // `resolveCanvas` applies downstream.
    const { ratio, size } = selection.canvas;
    if ((ratio !== undefined) === (size !== undefined)) {
      return err(new Error("Preview cell canvas must carry exactly one of ratio/size."));
    }
    if (size !== undefined && !(DISPLAY_SIZE_VALUES as readonly string[]).includes(size)) {
      return err(
        new Error(`Unsupported display size "${size}" (expected one of ${DISPLAY_SIZE_VALUES.join(", ")})`),
      );
    }
    // The background port speaks the social vocabulary; a display size borrows
    // its nearest orientation and the compositor stretches the result over the
    // exact canvas. Ratio validation (including the axis vocabulary) stays here.
    const backgroundRatio =
      ratio !== undefined
        ? AspectRatio.create(ratio)
        : AspectRatio.create(nearestSocialRatio(selection.canvas));
    if (!backgroundRatio.success) return backgroundRatio;

    const { request, backgroundSource } = await this.buildCompositeRequest(
      brief,
      selection,
      product,
      backgroundRatio.value,
    );
    const cacheKey = compositeRequestFingerprint(request, this.deps.hash);
    const cached = this.deps.frameCache?.get(cacheKey);
    if (cached !== undefined) {
      return ok({
        image: cached.image,
        cacheKey,
        logoApplied: cached.logoApplied,
        canvas: selection.canvas,
        backgroundSource,
      });
    }

    const composite = await this.deps.compositor.compositeAsset(request);
    this.deps.frameCache?.set(cacheKey, { image: composite.image, logoApplied: composite.logoApplied });
    return ok({
      image: composite.image,
      cacheKey,
      logoApplied: composite.logoApplied,
      canvas: selection.canvas,
      backgroundSource,
    });
  }

  /** The exact request the run would build for this cell — no forked math. */
  private async buildCompositeRequest(
    brief: CampaignBrief,
    selection: PreviewCellSelection,
    product: Product,
    backgroundRatio: AspectRatio,
  ): Promise<{ request: CompositeRequest; backgroundSource: BackgroundSource }> {
    // LocalizedMessageFallback — the use case resolves the copy, never the caller.
    const copy = brief.localizedMessage ?? brief.campaignMessage;
    const context: BackgroundContext = {
      campaignMessage: brief.campaignMessage,
      targetAudience: brief.targetAudience,
      targetRegion: brief.targetRegion,
      campaignType: brief.type,
    };
    const background = await this.deps.imageGenerator.resolveBackground(product, backgroundRatio, context);
    // D11: the same per-ratio union of the requested platforms' safe insets the
    // run passes — keyed by the social ratio, so a display size (which no
    // platform zone describes) passes none.
    const safeInsets =
      selection.canvas.ratio !== undefined
        ? unionSafeInsets(brief.output?.platforms, this.deps.platformSafeZones).get(selection.canvas.ratio)
        : undefined;
    const request: CompositeRequest = {
      background: background.image,
      message: copy,
      brandColor: product.primaryColor,
      logoPath: product.logoPath,
      canvas: selection.canvas,
      layout: selection.layout,
      tone: selection.tone,
      // Absent → the compositor derives from layout, byte-identical to the pre-axis path.
      ...(selection.anchor !== undefined ? { anchor: selection.anchor } : {}),
      // The template's type block rides the frame exactly as it rides the run
      // (GenerateCampaignUseCase:261) — a preview that ignores it is D45's failure.
      ...(brief.style !== undefined ? { style: brief.style } : {}),
      ...(safeInsets !== undefined ? { safeInsets } : {}),
      // The brief's template (D120/D123, C3) rides the frame exactly as it
      // rides the run: the preview draws the brief's order, not the
      // canonical fallback.
      template: brief.template,
    };
    return { request, backgroundSource: background.source };
  }
}
