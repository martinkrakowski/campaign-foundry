import { ok, err, type Result } from "@campaignfoundry/shared";
import type { CampaignBrief } from "../../domain/entities/CampaignBrief.js";
import type { GeneratedAsset } from "../../domain/entities/GeneratedAsset.js";
import { AspectRatio } from "../../domain/value-objects/AspectRatio.vo.js";
import { DEFAULT_TREATMENT, SAFE_ID_PATTERN } from "../../domain/value-objects/Treatment.vo.js";
import { PipelineExecutionLog } from "../../domain/value-objects/PipelineExecutionLog.vo.js";
import type { PipelineResult } from "../../domain/value-objects/PipelineResult.vo.js";
import type {
  CampaignExecutionOptions,
  CampaignPipelinePort,
} from "../ports/in/CampaignPipelinePort.js";
import type { CompliancePort } from "../ports/out/CompliancePort.js";
import type { CompositorPort } from "../ports/out/CompositorPort.js";
import type { ExportPort } from "../ports/out/ExportPort.js";
import type { ImageGeneratorPort } from "../ports/out/ImageGeneratorPort.js";

/** A campaign brief must contain at least this many unique products. */
const MINIMUM_PRODUCTS = 2;

/**
 * Cap on concurrently-generated backgrounds. Backgrounds are the slow GenAI step,
 * so we parallelize them — but each is a multi-megabyte image and an upstream
 * request, so an unbounded fan-out on a large brief would spike peak memory and
 * burst the provider. A small pool keeps the latency win for typical briefs while
 * bounding both.
 */
const MAX_CONCURRENT_BACKGROUNDS = 8;

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

/** Ports injected at the composition root — the use case depends on contracts, never adapters. */
export interface GenerateCampaignDeps {
  readonly imageGenerator: ImageGeneratorPort;
  readonly compositor: CompositorPort;
  readonly compliance: CompliancePort;
  readonly exporter: ExportPort;
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
    const log = new PipelineExecutionLog(brief.id);

    // 1. ValidateBriefIntegrity — MinimumProductsRule, before any port is called.
    const validation = this.validateBrief(brief);
    if (!validation.success) return validation;
    log.record("ValidateBriefIntegrity", `Brief valid — ${brief.products.length} products`);

    // 2. ExecuteLegalGateCheck — halt the run immediately on prohibited copy.
    const halt = await this.runLegalGate(brief, log);
    if (halt) return ok({ assets: [], log, halted: true });

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
    const selective = options?.regenerateOnly !== undefined;
    const targetKeys = selective
      ? new Set(
          (options?.regenerateOnly ?? []).map(
            (t) => `${t.productId}/${t.aspectRatio}/${t.treatment}`,
          ),
        )
      : null;
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

  /** MinimumProductsRule + path-safe/unique ids, or the pipeline never starts. */
  private validateBrief(brief: CampaignBrief): Result<true, Error> {
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
    if (unique.size < MINIMUM_PRODUCTS) {
      return err(
        new Error(
          `A campaign brief requires at least ${MINIMUM_PRODUCTS} unique products (received ${unique.size}).`,
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
    for (const text of checks) {
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
    log.record("ExecuteLegalGateCheck", "Legal gate passed");
    return false;
  }
}
