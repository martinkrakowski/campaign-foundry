import {
  GenerateCampaignUseCase,
  type CampaignBrief,
  type PipelineResult,
} from "@campaignfoundry/CampaignOrchestration";
import {
  NodeCanvasCompositor,
  ProceduralBackgroundGenerator,
} from "@campaignfoundry/CreativeGeneration";
import { BrandComplianceChecker } from "@campaignfoundry/GovernanceAndCompliance";
import { FileSystemExporter } from "@campaignfoundry/Distribution";
import type { Result } from "@campaignfoundry/shared";
import { outputRoot } from "./config.js";

/**
 * Composition root — the one place that knows concrete adapters. Wires them into
 * the use case via constructor injection; everything above depends only on ports.
 */
export function buildPipeline(): GenerateCampaignUseCase {
  return new GenerateCampaignUseCase({
    imageGenerator: new ProceduralBackgroundGenerator(),
    compositor: new NodeCanvasCompositor(),
    compliance: new BrandComplianceChecker(),
    exporter: new FileSystemExporter(outputRoot()),
  });
}

export function runCampaign(brief: CampaignBrief): Promise<Result<PipelineResult, Error>> {
  return buildPipeline().execute(brief);
}
