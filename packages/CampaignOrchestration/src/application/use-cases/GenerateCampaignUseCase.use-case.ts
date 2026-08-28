import { ok, err, type Result } from "@campaignfoundry/shared";
import type { CampaignBrief } from "../../domain/entities/CampaignBrief.js";
import type { GeneratedAsset, VariantDescriptor } from "../../domain/entities/GeneratedAsset.js";
import type { Product } from "../../domain/entities/Product.js";
import { variantTreatmentId, type Variant } from "../../domain/entities/Variant.js";
import { AspectRatio } from "../../domain/value-objects/AspectRatio.vo.js";
import type { AspectRatioValue } from "../../domain/value-objects/aspect-ratios.js";
import type { MotionKind } from "../../domain/value-objects/MotionKind.vo.js";
import { DEFAULT_TREATMENT, SAFE_ID_PATTERN } from "../../domain/value-objects/Treatment.vo.js";
import { PipelineExecutionLog } from "../../domain/value-objects/PipelineExecutionLog.vo.js";
import type { PipelineResult } from "../../domain/value-objects/PipelineResult.vo.js";
import type { VariationPlan } from "../../domain/value-objects/VariationPlan.vo.js";
import type {
  CampaignExecutionOptions,
  CampaignPipelinePort,
} from "../ports/in/CampaignPipelinePort.js";
import { isVariationTarget } from "../ports/in/CampaignPipelinePort.js";

/** A re-roll only makes sense against a run produced by the brief's current mode. */
export const RE_ROLL_MODE_MISMATCH = {
  classicTargetsOnRandomized:
    "The rejected creatives came from a classic run, but the brief is now a randomized campaign — the mode changed since that run, so they cannot be re-rolled; run the full campaign.",
  randomizedTargetsOnClassic:
    "The rejected creatives came from a randomized run, but the brief is now a classic campaign — the mode changed since that run, so they cannot be re-rolled; run the full campaign.",
} as const;
import type { CompliancePort } from "../ports/out/CompliancePort.js";
import type { CompositeRequest, CompositorPort, SafeInsets } from "../ports/out/CompositorPort.js";
import type { ExportPort } from "../ports/out/ExportPort.js";
import type { BackgroundContext, ImageGeneratorPort } from "../ports/out/ImageGeneratorPort.js";
import type { PlatformSafeZoneResolver } from "../ports/out/PlatformProfilePort.js";
import type { VideoCompositorPort } from "../ports/out/VideoCompositorPort.js";
import { MOTION_FPS } from "./PlanVariationsUseCase.use-case.js";

/** Classic briefs keep the two-product floor; variation relaxes to 1 (D10). */
const MINIMUM_PRODUCTS_CLASSIC = 2;
const MINIMUM_PRODUCTS_VARIATION = 1;

/**
 * Cap on concurrently-generated backgrounds. Backgrounds are the slow GenAI step,
 * so we parallelize them — but each is a multi-megabyte image and an upstream
 * request, so an unbounded fan-out on a large brief would spike peak memory and
 * burst the provider. A small pool keeps the latency win for typical briefs while
 * bounding both.
 */
const MAX_CONCURRENT_BACKGROUNDS = 8;

/** Normalised times whose frames are brand-density checked on a motion variant. */
const MOTION_SAMPLE_AT: readonly number[] = [0, 0.25, 0.5, 0.75, 1];
/** Planner default; a motion variant without `durationSec` (hand-built plan) encodes this. */
const DEFAULT_DURATION_SEC = 6;

/** Row identity + paths: the leading keys of every persisted asset row. */
type VariationAssetIdentity = Pick<GeneratedAsset, "productId" | "aspectRatio" | "outputPath" | "proofPath">;
/** Variation lineage: the keys that follow the compliance verdict in a persisted row. */
type VariationAssetLineage = Pick<
  GeneratedAsset,
  "treatment" | "backgroundSource" | "variantIndex" | "attempt" | "seed"
>;
/** A variation asset before its compliance verdict — shared by the static and motion renders. */
interface VariationAssetBase {
  readonly identity: VariationAssetIdentity;
  readonly lineage: VariationAssetLineage;
  readonly descriptor: VariantDescriptor;
  /** `<product>/<ratio>/v<index>.mp4` — written by a motion slot, removed by a still. */
  readonly videoPath: string;
}

/**
 * Run `fn` over `items` with at most `limit` in flight at once, preserving input
 * order in the result — a tiny bounded-concurrency pool (no external dependency) so
 * the pipeline can parallelize without an unbounded request burst.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Planner seam — `PlanVariationsUseCase` at the composition root, a fake in tests. */
export interface VariationPlanner {
  plan(brief: CampaignBrief): Result<VariationPlan, Error>;
  replan(plan: VariationPlan, index: number, attempt: number): Result<VariationPlan, Error>;
}

/** Ports injected at the composition root — the use case depends on contracts, never adapters. */
export interface GenerateCampaignDeps {
  readonly imageGenerator: ImageGeneratorPort;
  /** Dedicated procedural generator — variation `procedural` cells skip the GenAI chain. */
  readonly proceduralGenerator: ImageGeneratorPort;
  readonly planner: VariationPlanner;
  readonly compositor: CompositorPort;
  /** Motion variants only; static and classic paths never touch it. */
  readonly videoCompositor: VideoCompositorPort;
  readonly compliance: CompliancePort;
  readonly exporter: ExportPort;
  readonly now: () => Date;
  /** Safe-inset source for `output.platforms` (D11). Absent → no insets are ever passed. */
  readonly platformSafeZones?: PlatformSafeZoneResolver;
}

/**
 * GenerateCampaignUseCase orchestrates the full creative-automation pipeline:
 * validate → legal gate → (per product × aspect ratio) resolve background →
 * composite → visual compliance → save → proof.
 *
 * It contains the business workflow only; all I/O lives behind the four ports.
 */
export class GenerateCampaignUseCase implements CampaignPipelinePort {
  constructor(private readonly deps: GenerateCampaignDeps) {}

  async execute(
    brief: CampaignBrief,
    options?: CampaignExecutionOptions,
  ): Promise<Result<PipelineResult, Error>> {
    const log = new PipelineExecutionLog(brief.id, this.deps.now);

    // 1. ValidateBriefIntegrity — MinimumProductsRule, before any port is called.
    const validation = this.validateBrief(brief);
    if (!validation.success) return validation;
    log.record("ValidateBriefIntegrity", `Brief valid — ${brief.products.length} products`);

    // 2. ExecuteLegalGateCheck — halt the run immediately on prohibited copy.
    const halt = await this.runLegalGate(brief, log);
    if (halt) return ok({ assets: [], log, halted: true });

    if (brief.mode === "variation") {
      return this.executeVariation(brief, options, log);
    }

    // 3-7. Generate every creative: one per (product × aspect ratio × treatment).
    const ratios = AspectRatio.all();
    // A brief with no treatments still produces one creative per cell (back-compat).
    const treatments = brief.treatments?.length ? brief.treatments : [DEFAULT_TREATMENT];
    // Only namespace output by treatment when there's variation to disambiguate, so a
    // single-treatment brief keeps the documented `<product>/<ratio>.png` layout.
    const namespaceByTreatment = treatments.length > 1;

    // Selective regeneration (HITL re-roll): when `regenerateOnly` is present, only the
    // listed cells run — every other cell is skipped, leaving its output untouched.
    // Targets are matched by the same identity the review UI keys on. Absent → full run.
    const targets = options?.regenerateOnly;
    const targetKeys = targets
      ? new Set(
          targets.flatMap((t) =>
            isVariationTarget(t) ? [] : [`${t.productId}/${t.aspectRatio}/${t.treatment}`],
          ),
        )
      : null;
    // Every target must be keyed for this mode. A randomized-shaped one came from a
    // run produced before the brief was switched to classic; without this check it is
    // silently dropped — and a list of only such targets skips every cell, reporting a
    // successful run that regenerated nothing. An empty list stays a no-op run.
    if (targets !== undefined && targets.length > 0 && targets.some(isVariationTarget)) {
      return err(new Error(RE_ROLL_MODE_MISMATCH.randomizedTargetsOnClassic));
    }
    const isTarget = (productId: string, ratioValue: string, treatmentId: string): boolean =>
      targetKeys === null || targetKeys.has(`${productId}/${ratioValue}/${treatmentId}`);

    // Count only the cells this run will actually touch (full matrix, or the subset).
    log.totalOperations = brief.products.reduce(
      (total, product) =>
        total +
        ratios.reduce(
          (perProduct, ratio) =>
            perProduct +
            treatments.filter((t) => isTarget(product.id, ratio.value, t.id)).length,
          0,
        ),
      0,
    );
    // LocalizedMessageFallback — the use case resolves the copy; adapters never do.
    const copy = brief.localizedMessage ?? brief.campaignMessage;
    // Campaign context handed to the image generator for personalized (GenAI) backgrounds.
    const context = {
      campaignMessage: brief.campaignMessage,
      targetAudience: brief.targetAudience,
      targetRegion: brief.targetRegion,
    };
    // 3-6. Generate each in-scope cell (product × ratio): resolve its background, then
    // composite/score/save every treatment that shares it. Cells run with BOUNDED
    // concurrency — background generation is the slow GenAI step, so a sequential run
    // overran the dev proxy's request timeout; an unbounded fan-out would instead
    // buffer every multi-MB background at once and burst the provider. A small pool
    // gets the latency win while capping peak memory and in-flight requests: each
    // background is local to its cell and released once its composites are made. Each
    // generator still degrades on its own (Imagen → OpenRouter → procedural), so one
    // slow/failed provider can't stall the pool.
    const cells = brief.products.flatMap((product) =>
      ratios
        .map((ratio) => ({
          product,
          ratio,
          ratioTreatments: treatments.filter((t) => isTarget(product.id, ratio.value, t.id)),
        }))
        // On a selective run, skip a ratio entirely when none of its treatments are targeted.
        .filter((cell) => cell.ratioTreatments.length > 0),
    );

    const cellResults = await mapWithConcurrency(
      cells,
      MAX_CONCURRENT_BACKGROUNDS,
      async ({ product, ratio, ratioTreatments }) => {
        // ResolveBackgroundAssets — reuse inputAsset or generate, once per cell.
        const background = await this.deps.imageGenerator.resolveBackground(product, ratio, context);
        log.record(
          "ResolveBackgroundAssets",
          `${product.id} @ ${ratio.value} — background: ${background.source}${background.source === "procedural" ? " (procedural fallback — no GenAI background)" : ""}`,
          background.source === "procedural" ? "warn" : "info",
        );

        const cellAssets: GeneratedAsset[] = [];
        // The first treatment's 1:1 composite is this product's print-proof source.
        let heroImage: Uint8Array | undefined;
        for (const treatment of ratioTreatments) {
          // CompositeVariations — deterministic layer stacking, treatment-driven.
          const composite = await this.deps.compositor.compositeAsset({
            background: background.image,
            message: copy,
            brandColor: product.primaryColor,
            logoPath: product.logoPath,
            ratio,
            layout: treatment.layout,
            tone: treatment.tone,
          });

          // ExecuteVisualComplianceCheck — brand-colour density.
          const visual = await this.deps.compliance.validateBrandColorDensity(
            composite.image,
            product.primaryColor,
          );

          // SaveOutputFiles — the use case owns the path (OutputDirectoryConvention).
          const outputPath = namespaceByTreatment
            ? `${product.id}/${ratio.slug}/${treatment.id}.png`
            : `${product.id}/${ratio.slug}.png`;
          await this.deps.exporter.saveToDirectory(composite.image, outputPath);
          if (ratio.value === "1:1" && treatment === treatments[0]) heroImage = composite.image;

          cellAssets.push({
            productId: product.id,
            aspectRatio: ratio.value,
            outputPath,
            proofPath: `proofs/${product.id}.pdf`,
            complianceScore: visual.score ?? 0,
            passedCompliance: visual.passed,
            logoApplied: composite.logoApplied,
            treatment: treatment.id,
            backgroundSource: background.source,
          });
          log.record(
            "CompositeVariations",
            `${product.id} @ ${ratio.value} [${treatment.id}] — brand density ${(visual.score ?? 0).toFixed(3)}${visual.passed ? "" : " (below threshold)"}, logo ${composite.logoApplied ? "present" : "missing"}`,
            visual.passed && composite.logoApplied ? "info" : "warn",
          );
        }
        return { productId: product.id, assets: cellAssets, heroImage };
      },
    );

    // mapWithConcurrency preserves input order, so assets stay product → ratio → treatment.
    const assets: GeneratedAsset[] = cellResults.flatMap((cell) => cell.assets);

    // 7. ExportPrintProofs — one proof per product, from its 1:1 hero (first treatment).
    // On a selective run the hero only ran if it was targeted, so a non-hero re-roll
    // leaves the existing proof untouched.
    const heroByProduct = new Map<string, Uint8Array>();
    for (const cell of cellResults) {
      if (cell.heroImage) heroByProduct.set(cell.productId, cell.heroImage);
    }
    for (const product of brief.products) {
      const heroImage = heroByProduct.get(product.id);
      if (!heroImage) continue;
      await this.deps.exporter.generatePrintProof(heroImage, `proofs/${product.id}.pdf`);
      log.record("ExportPrintProofs", `Print proof written for ${product.id}`);
    }

    log.complete();
    return ok({ assets, log, halted: false });
  }

  /**
   * Variation path: plan (or replan targeted slots), then generate one creative
   * per variant. Classic matrix, keys, and paths are untouched.
   */
  private async executeVariation(
    brief: CampaignBrief,
    options: CampaignExecutionOptions | undefined,
    log: PipelineExecutionLog,
  ): Promise<Result<PipelineResult, Error>> {
    const planned = this.deps.planner.plan(brief);
    if (!planned.success) return planned;
    let plan = planned.value;

    const copy = brief.localizedMessage ?? brief.campaignMessage;
    const context: BackgroundContext = {
      campaignMessage: brief.campaignMessage,
      targetAudience: brief.targetAudience,
      targetRegion: brief.targetRegion,
    };

    const targets = options?.regenerateOnly;
    let variants: readonly Variant[];
    const attemptByIndex = new Map<number, number>();
    if (targets) {
      // Every target must be keyed for this mode. A classic-shaped one came from a run
      // produced before the brief was switched to randomized; say so and say what to
      // do, rather than silently dropping it. An empty list stays a no-op run.
      if (targets.length > 0 && targets.some((target) => !isVariationTarget(target))) {
        return err(new Error(RE_ROLL_MODE_MISMATCH.classicTargetsOnRandomized));
      }
      const variationTargets = targets.filter(isVariationTarget);
      const seen = new Set<number>();
      const unique = variationTargets.filter((target) => {
        if (seen.has(target.variantIndex)) return false;
        seen.add(target.variantIndex);
        return true;
      });
      const slots: Variant[] = [];
      for (const target of unique) {
        if (
          !Number.isInteger(target.variantIndex) ||
          target.variantIndex < 0 ||
          target.variantIndex >= plan.variants.length
        ) {
          return err(new Error(`Invalid variant index ${target.variantIndex}.`));
        }
        const occupant = plan.variants[target.variantIndex];
        if (occupant.productId !== target.productId) {
          return err(
            new Error(
              `Variation target productId "${target.productId}" does not match plan slot ${target.variantIndex} ("${occupant.productId}").`,
            ),
          );
        }
        const attempt = target.attempt ?? 1;
        if (!Number.isInteger(attempt) || attempt < 1) {
          return err(new Error(`replan attempt must be an integer >= 1 (received ${attempt}).`));
        }
        const next = this.deps.planner.replan(plan, target.variantIndex, attempt);
        if (!next.success) return next;
        plan = next.value;
        slots.push(plan.variants[target.variantIndex]);
        attemptByIndex.set(target.variantIndex, attempt);
      }
      variants = slots;
    } else {
      variants = plan.variants;
    }

    // Pooled headlines are copy too: gate every distinct text the (re)plan will
    // render, halting exactly like a prohibited campaignMessage would.
    const headlines = [...new Set(plan.variants.flatMap((v) => (v.headline === undefined ? [] : [v.headline])))];
    if (await this.haltsOnProhibitedCopy(headlines, log)) return ok({ assets: [], log, halted: true });

    log.totalOperations = variants.length;
    log.record(
      "PlanVariations",
      `policy ${plan.policyHash} seed ${plan.seed} — ${variants.length} variants`,
    );

    const pinnedProofIndex = firstSquareIndexByProduct(plan.variants);
    // D11: the union (max per side) of the requested platforms' insets, per ratio.
    // Briefs without platforms pass nothing, so their geometry is byte-identical.
    const insetsByRatio = unionSafeInsets(brief.output?.platforms, this.deps.platformSafeZones);

    const productById = new Map(brief.products.map((product) => [product.id, product]));
    const cells: Array<{ variant: Variant; product: Product; ratio: AspectRatio; attempt: number }> =
      [];
    for (const variant of variants) {
      const product = productById.get(variant.productId);
      if (!product) {
        return err(new Error(`Variation plan references unknown product "${variant.productId}".`));
      }
      const ratio = AspectRatio.create(variant.aspectRatio);
      if (!ratio.success) return ratio;
      cells.push({
        variant,
        product,
        ratio: ratio.value,
        attempt: attemptByIndex.get(variant.index) ?? 0,
      });
    }

    const cellResults = await mapWithConcurrency(cells, MAX_CONCURRENT_BACKGROUNDS, (cell) =>
      this.renderVariant(
        cell.variant,
        cell.product,
        cell.ratio,
        copy,
        context,
        log,
        cell.attempt,
        pinnedProofIndex.get(cell.product.id) === cell.variant.index,
        insetsByRatio.get(cell.ratio.value),
      ),
    );

    const assets: GeneratedAsset[] = cellResults.map((cell) => cell.asset);
    const heroByProduct = new Map<string, Uint8Array>();
    for (const cell of cellResults) {
      if (cell.heroImage && !heroByProduct.has(cell.asset.productId)) {
        heroByProduct.set(cell.asset.productId, cell.heroImage);
      }
    }
    for (const product of brief.products) {
      const heroImage = heroByProduct.get(product.id);
      if (!heroImage) continue;
      await this.deps.exporter.generatePrintProof(heroImage, `proofs/${product.id}.pdf`);
      log.record("ExportPrintProofs", `Print proof written for ${product.id}`);
    }

    log.complete();
    return ok({
      assets,
      log,
      halted: false,
      policyHash: plan.policyHash,
      seed: plan.seed,
    });
  }

  private async renderVariant(
    variant: Variant,
    product: Product,
    ratio: AspectRatio,
    copy: string,
    context: BackgroundContext,
    log: PipelineExecutionLog,
    attempt: number,
    writeProof: boolean,
    safeInsets: SafeInsets | undefined,
  ): Promise<{ asset: GeneratedAsset; heroImage?: Uint8Array }> {
    const cellContext: BackgroundContext = {
      ...context,
      seed: variant.seed,
      paletteShift: variant.paletteShift,
    };
    const generator =
      variant.backgroundSource === "procedural"
        ? this.deps.proceduralGenerator
        : this.deps.imageGenerator;
    const background = await generator.resolveBackground(product, ratio, cellContext);
    log.record(
      "ResolveBackgroundAssets",
      `${product.id} @ ${ratio.value} v${variant.index} — background: ${background.source}${background.source === "procedural" ? " (procedural fallback — no GenAI background)" : ""}`,
      background.source === "procedural" ? "warn" : "info",
    );

    const request: CompositeRequest = {
      background: background.image,
      message: variant.headline ?? copy,
      brandColor: product.primaryColor,
      logoPath: product.logoPath,
      ratio,
      layout: variant.layout,
      tone: variant.tone,
      ...(safeInsets !== undefined ? { safeInsets } : {}),
    };

    const treatment = variantTreatmentId(variant);
    const basePath = `${product.id}/${ratio.slug}/v${variant.index}`;
    const outputPath = `${basePath}.png`;
    const videoPath = `${basePath}.mp4`;
    const identity: VariationAssetIdentity = {
      productId: product.id,
      aspectRatio: ratio.value,
      outputPath,
      proofPath: `proofs/${product.id}.pdf`,
    };
    const lineage: VariationAssetLineage = {
      treatment,
      backgroundSource: background.source,
      variantIndex: variant.index,
      attempt,
      seed: variant.seed,
    };
    const descriptor: VariantDescriptor = {
      layout: variant.layout,
      tone: variant.tone,
      backgroundSource: variant.backgroundSource,
      paletteShift: variant.paletteShift,
      // Provenance: which pool text this slot rendered (report + grid chip).
      ...(variant.headline === undefined ? {} : { headline: variant.headline }),
    };

    if (variant.motion !== undefined) {
      return this.renderMotionVariant(
        variant,
        variant.motion,
        product,
        ratio,
        request,
        { identity, lineage, descriptor, videoPath },
        log,
        writeProof,
      );
    }

    const composite = await this.deps.compositor.compositeAsset(request);

    const visual = await this.deps.compliance.validateBrandColorDensity(
      composite.image,
      product.primaryColor,
    );

    await this.deps.exporter.saveToDirectory(composite.image, outputPath);
    // A re-roll of a former motion slot must not leave its clip behind: the grid,
    // export and packaging key on the row, and a stale mp4 would still be served.
    await this.deps.exporter.remove(videoPath);

    // Key order matches the classic/static row exactly, so static variation
    // reports stay byte-identical to the pre-motion pipeline.
    const asset: GeneratedAsset = {
      ...identity,
      complianceScore: visual.score ?? 0,
      passedCompliance: visual.passed,
      logoApplied: composite.logoApplied,
      ...lineage,
      format: "static",
      descriptor,
    };
    log.record(
      "CompositeVariations",
      `${product.id} @ ${ratio.value} [v${variant.index} ${treatment}] — brand density ${(visual.score ?? 0).toFixed(3)}${visual.passed ? "" : " (below threshold)"}, logo ${composite.logoApplied ? "present" : "missing"}`,
      visual.passed && composite.logoApplied ? "info" : "warn",
    );
    return {
      asset,
      heroImage: writeProof ? composite.image : undefined,
    };
  }

  /**
   * Motion slot: encode the clip, brand-check every sampled frame (the asset
   * passes only if all do; the minimum score is recorded), save `.mp4` + poster.
   * The poster is the still the grid, export, packaging, and proof keep using.
   */
  private async renderMotionVariant(
    variant: Variant,
    motion: MotionKind,
    product: Product,
    ratio: AspectRatio,
    request: CompositeRequest,
    { identity, lineage, descriptor, videoPath }: VariationAssetBase,
    log: PipelineExecutionLog,
    writeProof: boolean,
  ): Promise<{ asset: GeneratedAsset; heroImage?: Uint8Array }> {
    const durationSec = variant.durationSec ?? DEFAULT_DURATION_SEC;
    const video = await this.deps.videoCompositor.compositeVideo({
      ...request,
      durationSec,
      fps: MOTION_FPS,
      motion,
      sampleAt: MOTION_SAMPLE_AT,
    });

    // No sampled frame is no evidence: an adapter that returns none fails the check.
    let passed = video.sampledFrames.length > 0;
    let minScore = passed ? 1 : 0;
    for (const frame of video.sampledFrames) {
      const visual = await this.deps.compliance.validateBrandColorDensity(frame, product.primaryColor);
      if (!visual.passed) passed = false;
      minScore = Math.min(minScore, visual.score ?? 0);
    }

    await this.deps.exporter.saveToDirectory(video.video, videoPath);
    await this.deps.exporter.saveToDirectory(video.poster, identity.outputPath);

    const asset: GeneratedAsset = {
      ...identity,
      complianceScore: minScore,
      passedCompliance: passed,
      logoApplied: video.logoApplied,
      ...lineage,
      format: "motion",
      descriptor: { ...descriptor, motion, durationSec },
      videoPath,
      durationSec,
    };
    log.record(
      "CompositeVariations",
      `${product.id} @ ${ratio.value} [v${variant.index} ${lineage.treatment} ${motion} ${durationSec}s] — min brand density over ${video.sampledFrames.length} frames ${minScore.toFixed(3)}${passed ? "" : " (below threshold)"}, logo ${video.logoApplied ? "present" : "missing"}`,
      passed && video.logoApplied ? "info" : "warn",
    );
    // The proof pin is by plan order and ratio; a pinned motion 1:1 hero proofs from its poster.
    return { asset, heroImage: writeProof ? video.poster : undefined };
  }

  /** MinimumProductsRule + path-safe/unique ids, or the pipeline never starts. */
  private validateBrief(brief: CampaignBrief): Result<true, Error> {
    // The brief id is the campaign's persisted-report filename (per-campaign reload);
    // enforce path-safety here too (defense-in-depth) so a caller bypassing parsing
    // can't create a campaign that runs but can never be persisted/reloaded by id.
    if (!SAFE_ID_PATTERN.test(brief.id)) {
      return err(
        new Error("Campaign id must be a path-safe slug (lowercase letters, digits, hyphens; max 64 chars)."),
      );
    }
    // Product and treatment ids are output-path segments and the asset identity.
    // Enforce path-safety here too (domain-level defense-in-depth) so callers that
    // bypass brief parsing can't slip a malformed brief through: a path-unsafe id
    // (e.g. "foo/bar") creates unintended nesting that the exporter's traversal
    // guard doesn't catch, and duplicate treatment ids silently overwrite output.
    const productIds = brief.products.map((p) => p.id);
    if (productIds.some((id) => !SAFE_ID_PATTERN.test(id))) {
      return err(
        new Error("Product ids must be path-safe slugs (lowercase letters, digits, hyphens; max 64 chars)."),
      );
    }
    const unique = new Set(productIds);
    // Reject duplicate product ids: the id is the output-path segment, proof name, and
    // per-product key, so a repeat would silently overwrite another product's creatives.
    if (unique.size !== productIds.length) {
      return err(new Error("A campaign brief requires unique product ids."));
    }
    const minProducts =
      brief.mode === "variation" ? MINIMUM_PRODUCTS_VARIATION : MINIMUM_PRODUCTS_CLASSIC;
    if (unique.size < minProducts) {
      return err(
        new Error(
          `A campaign brief requires at least ${minProducts} unique products (received ${unique.size}).`,
        ),
      );
    }
    if (brief.treatments) {
      const ids = brief.treatments.map((t) => t.id);
      if (ids.some((id) => !SAFE_ID_PATTERN.test(id))) {
        return err(
          new Error("Treatment ids must be path-safe slugs (lowercase letters, digits, hyphens; max 64 chars)."),
        );
      }
      if (new Set(ids).size !== ids.length) {
        return err(new Error("A campaign brief requires unique treatment ids."));
      }
    }
    return ok(true);
  }

  /** Runs the legal gate over the campaign copy (and localized copy). Returns true if the run must halt. */
  private async runLegalGate(brief: CampaignBrief, log: PipelineExecutionLog): Promise<boolean> {
    const checks = [brief.campaignMessage, brief.localizedMessage].filter(
      (t): t is string => typeof t === "string" && t.length > 0,
    );
    if (await this.haltsOnProhibitedCopy(checks, log)) return true;
    log.record("ExecuteLegalGateCheck", "Legal gate passed");
    return false;
  }

  /** Legal-gate each text; on the first failure record the halt (same stage/shape) and return true. */
  private async haltsOnProhibitedCopy(texts: readonly string[], log: PipelineExecutionLog): Promise<boolean> {
    for (const text of texts) {
      const result = await this.deps.compliance.validateLegalCopy(text);
      if (!result.passed) {
        log.record(
          "ExecuteLegalGateCheck",
          `Pipeline halted — ${result.reason ?? "prohibited terminology detected"}`,
          "error",
        );
        log.complete();
        return true;
      }
    }
    return false;
  }
}

/**
 * D11: per ratio, the max-per-side union of the requested platforms' safe insets.
 * Unknown platform ids and ratios no platform targets are absent from the map.
 */
export function unionSafeInsets(
  platformIds: readonly string[] | undefined,
  resolve: PlatformSafeZoneResolver | undefined,
): Map<AspectRatioValue, SafeInsets> {
  const byRatio = new Map<AspectRatioValue, SafeInsets>();
  if (!platformIds || !resolve) return byRatio;
  for (const id of platformIds) {
    const zone = resolve(id);
    if (!zone) continue;
    const current = byRatio.get(zone.ratio);
    byRatio.set(
      zone.ratio,
      current === undefined
        ? zone.safeInsets
        : {
            top: Math.max(current.top, zone.safeInsets.top),
            right: Math.max(current.right, zone.safeInsets.right),
            bottom: Math.max(current.bottom, zone.safeInsets.bottom),
            left: Math.max(current.left, zone.safeInsets.left),
          },
    );
  }
  return byRatio;
}

/** First 1:1 variant of each product in plan order — the only slot that may rewrite its proof. */
function firstSquareIndexByProduct(variants: readonly Variant[]): Map<string, number> {
  const pinned = new Map<string, number>();
  for (const variant of variants) {
    if (variant.aspectRatio === "1:1" && !pinned.has(variant.productId)) {
      pinned.set(variant.productId, variant.index);
    }
  }
  return pinned;
}
