import { ok, err, type Result } from "@campaignfoundry/shared";
import type { CampaignBrief } from "../../domain/entities/CampaignBrief.js";
import type { GeneratedAsset } from "../../domain/entities/GeneratedAsset.js";
import { AspectRatio } from "../../domain/value-objects/AspectRatio.vo.js";
import { PipelineExecutionLog } from "../../domain/value-objects/PipelineExecutionLog.vo.js";
import type { PipelineResult } from "../../domain/value-objects/PipelineResult.vo.js";
import type { CampaignPipelinePort } from "../ports/in/CampaignPipelinePort.js";
import type { CompliancePort } from "../ports/out/CompliancePort.js";
import type { CompositorPort } from "../ports/out/CompositorPort.js";
import type { ExportPort } from "../ports/out/ExportPort.js";
import type { ImageGeneratorPort } from "../ports/out/ImageGeneratorPort.js";

/** A campaign brief must contain at least this many unique products. */
const MINIMUM_PRODUCTS = 2;

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

  async execute(brief: CampaignBrief): Promise<Result<PipelineResult, Error>> {
    const log = new PipelineExecutionLog(brief.id);

    // 1. ValidateBriefIntegrity — MinimumProductsRule, before any port is called.
    const validation = this.validateBrief(brief);
    if (!validation.success) return validation;
    log.record("ValidateBriefIntegrity", `Brief valid — ${brief.products.length} products`);

    // 2. ExecuteLegalGateCheck — halt the run immediately on prohibited copy.
    const halt = await this.runLegalGate(brief, log);
    if (halt) return ok({ assets: [], log, halted: true });

    // 3-7. Generate every creative: one per (product × aspect ratio).
    const ratios = AspectRatio.all();
    log.totalOperations = brief.products.length * ratios.length;
    // LocalizedMessageFallback — the use case resolves the copy; adapters never do.
    const copy = brief.localizedMessage ?? brief.campaignMessage;
    // Campaign context handed to the image generator for personalized (GenAI) backgrounds.
    const context = {
      campaignMessage: brief.campaignMessage,
      targetAudience: brief.targetAudience,
      targetRegion: brief.targetRegion,
    };
    const assets: GeneratedAsset[] = [];

    for (const product of brief.products) {
      const proofPath = `proofs/${product.id}.pdf`;
      let proofSource: Uint8Array | undefined;

      for (const ratio of ratios) {
        // 3. ResolveBackgroundAssets — reuse inputAsset or generate.
        const background = await this.deps.imageGenerator.resolveBackground(product, ratio, context);

        // 4. CompositeVariations — deterministic layer stacking.
        const composite = await this.deps.compositor.compositeAsset({
          background,
          message: copy,
          logoPath: product.logoPath,
          ratio,
        });

        // 5. ExecuteVisualComplianceCheck — brand-colour density.
        const visual = await this.deps.compliance.validateBrandColorDensity(
          composite,
          product.primaryColor,
        );

        // 6. SaveOutputFiles — the use case owns the path (OutputDirectoryConvention).
        const outputPath = `${product.id}/${ratio.slug}.png`;
        await this.deps.exporter.saveToDirectory(composite, outputPath);
        if (ratio.value === "1:1" || proofSource === undefined) proofSource = composite;

        assets.push({
          productId: product.id,
          aspectRatio: ratio.value,
          outputPath,
          proofPath,
          complianceScore: visual.score ?? 0,
          passedCompliance: visual.passed,
        });
        log.record(
          "CompositeVariations",
          `${product.id} @ ${ratio.value} — brand density ${(visual.score ?? 0).toFixed(3)}${visual.passed ? "" : " (below threshold)"}`,
          visual.passed ? "info" : "warn",
        );
      }

      // 7. ExportPrintProofs — one proof per product (hero 1:1 creative).
      if (proofSource) {
        await this.deps.exporter.generatePrintProof(proofSource, proofPath);
        log.record("ExportPrintProofs", `Print proof written for ${product.id}`);
      }
    }

    log.complete();
    return ok({ assets, log, halted: false });
  }

  /** MinimumProductsRule: at least two unique products, or the pipeline never starts. */
  private validateBrief(brief: CampaignBrief): Result<true, Error> {
    const unique = new Set(brief.products.map((p) => p.id));
    if (unique.size < MINIMUM_PRODUCTS) {
      return err(
        new Error(
          `A campaign brief requires at least ${MINIMUM_PRODUCTS} unique products (received ${unique.size}).`,
        ),
      );
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
