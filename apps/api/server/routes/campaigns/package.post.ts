import {
  FileSystemPackageStore,
  PackageForPlatformUseCase,
  type PackageStorePort,
} from "@campaignfoundry/Distribution";
import { getCapabilities } from "../../lib/capabilities.js";
import { getBriefStore, getOutputStore } from "../../lib/ports/index.js";
import { storageRoots } from "../../lib/run-environment.js";
import { isPersistedAsset, type PersistedAsset, readReport } from "../../lib/report.js";

import { requestTenant } from "../../lib/tenant.js";
/** Upper bound on `include` entries — a run is at most a few hundred creatives. */
const MAX_INCLUDE = 1000;

interface PackageRequest {
  campaignId: string;
  platforms: readonly string[];
  include?: readonly string[];
}

function parseInclude(include: unknown): readonly string[] | undefined {
  if (include === undefined) return undefined;
  if (!Array.isArray(include) || include.some((k) => typeof k !== "string")) {
    throw new Error("include must be an array of strings");
  }
  if (include.length > MAX_INCLUDE) {
    throw new Error(`include must have at most ${MAX_INCLUDE} entries`);
  }
  return include as string[];
}

function parsePackageRequest(body: unknown): PackageRequest {
  if (typeof body !== "object" || body === null) {
    throw new Error("Request body must be an object");
  }
  const record = body as { campaignId?: unknown; platforms?: unknown; include?: unknown };
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
  const seen = new Set<string>();
  const platforms: string[] = [];
  for (const platform of record.platforms) {
    if (seen.has(platform)) continue;
    seen.add(platform);
    platforms.push(platform);
  }
  const include = parseInclude(record.include);
  return include === undefined
    ? { campaignId: record.campaignId, platforms }
    : { campaignId: record.campaignId, platforms, include };
}

function persistedAssetsFrom(
  report: unknown,
): { assets: PersistedAsset[]; skipped: number } | { error: string } {
  if (typeof report !== "object" || report === null) {
    return { error: "Campaign report assets must be an array" };
  }
  const assets = (report as { assets?: unknown }).assets;
  if (!Array.isArray(assets)) {
    return { error: "Campaign report assets must be an array" };
  }
  const valid = assets.filter(isPersistedAsset);
  return { assets: valid, skipped: assets.length - valid.length };
}

/**
 * POST /campaigns/package — copy a run's already-rendered creatives into
 * per-platform folders under `output/packages/<campaignId>/<platformId>/`.
 * Never re-renders. The package is the current output for that report
 * (renders are not campaign-namespaced; `packagedAt` records when this copy
 * was taken). Body: `{ campaignId, platforms, include? }` — `include` is the
 * list of asset identities the reviewer approved; omitted packages every asset.
 */
export default defineEventHandler(async (event) => {
  const scope = requestTenant(event);
  let campaignId: string;
  let platforms: readonly string[];
  let include: readonly string[] | undefined;
  try {
    const body: unknown = await readBody(event);
    ({ campaignId, platforms, include } = parsePackageRequest(body));
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: error instanceof Error ? error.message : "Invalid package request" };
  }

  const briefs = getBriefStore(scope);
  // See result.get.ts: resolve a uuid to its slug, pass a slug through unchanged
  // (an unsaved draft has no campaign row yet — packaging an unsaved run's
  // output is a supported flow); readReport below still answers undefined for
  // a ref that is genuinely unknown either way.
  const resolved = await briefs.resolveCampaign(campaignId);
  const slug = resolved?.slug ?? campaignId;
  if (briefs.supportsTeams && (await briefs.campaignVisibility(slug)) === "hidden") {
    setResponseStatus(event, 404);
    return { error: "Campaign report not found" };
  }

  const report = await readReport(scope, slug);
  if (report === undefined) {
    setResponseStatus(event, 404);
    return { error: "Campaign report not found" };
  }

  const parsed = persistedAssetsFrom(report);
  if ("error" in parsed) {
    setResponseStatus(event, 422);
    return { error: parsed.error };
  }

  const outputStore = getOutputStore(scope);
  const fsPackageStore = new FileSystemPackageStore(storageRoots(scope).outputRoot, slug);
  const packageStore: PackageStorePort = {
    async readAsset(relativePath: string): Promise<Uint8Array> {
      const lookup = await outputStore.openOutput(relativePath);
      if (!lookup.found) {
        throw new Error(`Asset not found: ${relativePath}`);
      }
      const chunks: Buffer[] = [];
      const stream = lookup.file.stream();
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    },
    writePackaged: (platformId, relativePath, bytes) =>
      fsPackageStore.writePackaged(platformId, relativePath, bytes),
    writeManifest: (platformId, manifest) => fsPackageStore.writeManifest(platformId, manifest),
  };

  const result = await new PackageForPlatformUseCase(packageStore).execute({
    campaignId: slug,
    assets: parsed.assets,
    platforms,
    packagedAt: new Date().toISOString(),
    skipped: parsed.skipped,
    include,
    // Motion platforms are packageable only while the ffmpeg probe says so.
    capabilities: { motion: getCapabilities().motion },
  });
  if (!result.success) {
    setResponseStatus(event, 422);
    return { error: result.error.message };
  }
  return result.value;
});
