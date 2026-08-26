import type { GeneratedAsset } from "@campaignfoundry/CampaignOrchestration";
import { FileSystemPackageStore, PackageForPlatformUseCase } from "@campaignfoundry/Distribution";
import { outputRoot } from "../../lib/config.js";
import { readReport } from "../../lib/report.js";

function parsePackageRequest(body: unknown): { campaignId: string; platforms: readonly string[] } {
  if (typeof body !== "object" || body === null) {
    throw new Error("Request body must be an object");
  }
  const record = body as { campaignId?: unknown; platforms?: unknown };
  if (typeof record.campaignId !== "string" || record.campaignId.length === 0) {
    throw new Error("campaignId is required");
  }
  if (
    !Array.isArray(record.platforms) ||
    record.platforms.length === 0 ||
    record.platforms.some((p) => typeof p !== "string")
  ) {
    throw new Error("platforms must be a non-empty array of strings");
  }
  return { campaignId: record.campaignId, platforms: record.platforms };
}

function assetsFrom(report: unknown): GeneratedAsset[] {
  if (typeof report !== "object" || report === null) return [];
  const assets = (report as { assets?: unknown }).assets;
  return Array.isArray(assets) ? (assets as GeneratedAsset[]) : [];
}

/**
 * POST /campaigns/package — copy a run's already-rendered creatives into
 * per-platform folders. Never re-renders. Body: `{ campaignId, platforms }`.
 */
export default defineEventHandler(async (event) => {
  let campaignId: string;
  let platforms: readonly string[];
  try {
    const body: unknown = await readBody(event);
    ({ campaignId, platforms } = parsePackageRequest(body));
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: error instanceof Error ? error.message : "Invalid package request" };
  }

  const root = outputRoot();
  const report = await readReport(root, campaignId);
  if (report === undefined) {
    setResponseStatus(event, 404);
    return { error: "Campaign report not found" };
  }

  const result = await new PackageForPlatformUseCase(new FileSystemPackageStore(root, campaignId)).execute({
    campaignId,
    assets: assetsFrom(report),
    platforms,
  });
  if (!result.success) {
    setResponseStatus(event, 400);
    return { error: result.error.message };
  }
  return result.value;
});
