import {
  PublishAdClipUseCase,
  PublicMediaNotConfiguredError,
} from "@campaignfoundry/CampaignOrchestration";
import {
  FileSystemPackageStore,
  ObjectPackageStore,
  PackageForPlatformUseCase,
  renderObjectKey,
  type ClipPublisher,
  type PackageStorePort,
} from "@campaignfoundry/Distribution";
import { createHash } from "node:crypto";
import { errorMessage } from "@campaignfoundry/shared";
import { getCapabilities } from "../../lib/capabilities.js";
import { objectStore } from "../../lib/config.js";
import { database } from "../../lib/db/database.js";
import { objectStoreClient, publicAdMediaClient } from "../../lib/object-store/index.js";
import { packagePrefix, renderPrefix } from "../../lib/object-store/object-keys.js";
import { renderTarget, type RenderTarget } from "../../lib/object-store/render-target.js";
import { PgPublishedClipStore } from "../../lib/ports/pg-published-clip-store.js";
import { getBriefStore, getOutputStore } from "../../lib/ports/index.js";
import { storageRoots } from "../../lib/run-environment.js";
import { isPersistedAsset, type PersistedAsset, readReport } from "../../lib/report.js";

import { requestTenant, type TenantContext } from "../../lib/tenant.js";
/** Upper bound on `include` entries — a run is at most a few hundred creatives. */
const MAX_INCLUDE = 1000;

/** The hash `PublishAdClipUseCase` fingerprints published clips with. */
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * `publishClip` is a PUBLIC-bucket feature: it reads renders through the object
 * store and publishes to the public ad-media bucket. Under `fs` neither exists,
 * and a silent no-publish would ship the very placeholders the flag exists to
 * replace — so the request is refused instead.
 */
export class PublicMediaRequiresObjectStoreError extends Error {
  constructor() {
    super("Publishing ad clips requires OBJECT_STORE=s3.");
    this.name = "PublicMediaRequiresObjectStoreError";
  }
}

interface PackageRequest {
  campaignId: string;
  platforms: readonly string[];
  include?: readonly string[];
  /** Always present after `parsePackageRequest` — absent in the body means `false`. */
  publishClip: boolean;
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
  const record = body as {
    campaignId?: unknown;
    platforms?: unknown;
    include?: unknown;
    publishClip?: unknown;
  };
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
  if (record.publishClip !== undefined && typeof record.publishClip !== "boolean") {
    throw new Error("publishClip must be a boolean");
  }
  const seen = new Set<string>();
  const platforms: string[] = [];
  for (const platform of record.platforms) {
    if (seen.has(platform)) continue;
    seen.add(platform);
    platforms.push(platform);
  }
  const include = parseInclude(record.include);
  return {
    campaignId: record.campaignId,
    platforms,
    ...(include === undefined ? {} : { include }),
    // Default: no publishing. An absent flag refuses placeholder bundles below.
    publishClip: record.publishClip === true,
  };
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
 * per-platform packages. Never re-renders. The package is the current output for
 * that report (renders are not campaign-namespaced; `packagedAt` records when
 * this copy was taken). Body: `{ campaignId, platforms, include? }` — `include`
 * is the list of asset identities the reviewer approved; omitted packages every
 * asset.
 *
 * **Where the bytes go follows `OBJECT_STORE` (PT-4h1).** Under `fs` that is
 * today's `output/packages/<campaignId>/<platformId>/` and today's composite
 * store, unchanged: a `readAsset` through the output store plus staged writes
 * through `FileSystemPackageStore`. Under `s3` it is `ObjectPackageStore`, which
 * reads renders from objects and writes each platform's package to a fresh
 * generation under `org/<orgId>/campaign/<uuid>/packages/`, made live by the
 * manifest written last (D209f).
 *
 * The s3 branch resolves the campaign's ONCE, through the same `renderTarget` the
 * pipeline resolves — so the packaging path and the render path cannot disagree
 * about which uuid a campaign's bytes belong under — and 404s when there is none.
 * Nothing can have rendered to objects without a target, because `buildPipeline`
 * refuses without one, so an absent target here means a campaign this org does not
 * have, and answering 404 says exactly that.
 */
export default defineEventHandler(async (event) => {
  const scope = requestTenant(event);
  let campaignId: string;
  let platforms: readonly string[];
  let include: readonly string[] | undefined;
  let publishClip: boolean;
  try {
    const body: unknown = await readBody(event);
    ({ campaignId, platforms, include, publishClip } = parsePackageRequest(body));
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: error instanceof Error ? error.message : "Invalid package request" };
  }

  // Publishing (CFAR6C3) is refused BEFORE anything is read or written, and as a
  // 422 body rather than a thrown error — a throw here would answer 500 and look
  // like a crash rather than a deployment this feature does not exist on.
  let publishAdClipUseCase: PublishAdClipUseCase | undefined;
  if (publishClip) {
    if (objectStore() === "fs") {
      setResponseStatus(event, 422);
      return { error: new PublicMediaRequiresObjectStoreError().message };
    }
    const media = publicAdMediaClient();
    if (media === undefined) {
      setResponseStatus(event, 422);
      return { error: new PublicMediaNotConfiguredError().message };
    }
    publishAdClipUseCase = new PublishAdClipUseCase({
      objectStore: objectStoreClient(),
      publicAdMedia: media,
      publishedClipRecord: new PgPublishedClipStore(database()),
      sha256,
    });
  }

  const briefs = getBriefStore(scope);
  // See result.get.ts: resolve a uuid to its slug on a backend that has one
  // (D178), pass a slug through unchanged otherwise — an unsaved draft has no
  // campaign row yet (packaging an unsaved run's output is a supported flow),
  // and on fs the id IS the slug (D179), so no lookup runs there. readReport
  // below still answers undefined for a genuinely unknown ref.
  const resolved = briefs.supportsTeams ? await briefs.resolveCampaign(campaignId) : undefined;
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

  // The target is resolved ONCE and shared by both consumers below — the package
  // store that reads renders and, when publishing, the clip publisher that keys
  // its render reads — so the two can never disagree about which uuid a
  // campaign's bytes belong under.
  const target = objectStore() === "fs" ? undefined : await renderTarget({ tenant: scope }, slug);
  if (objectStore() === "s3" && target === undefined) {
    setResponseStatus(event, 404);
    return { error: "Campaign report not found" };
  }
  const packageStore =
    target === undefined ? fsPackageStore(scope, slug) : objectPackageStoreFor(scope, target);

  // The publisher callback the use case calls once per DISTINCT placeholder
  // selector. The org comes from the authenticated tenant, never from the body:
  // a request body is untrusted input, not a tenancy decision.
  let clipPublisher: ClipPublisher | undefined;
  if (publishClip && publishAdClipUseCase !== undefined && target !== undefined) {
    clipPublisher = async (selector: string): Promise<string> => {
      const renderKey = renderObjectKey(
        renderPrefix(scope.orgId, target.campaignId),
        target.slug,
        `${target.slug}/${selector}`,
      );
      const { url } = await publishAdClipUseCase.execute({
        orgId: scope.orgId,
        campaignId: target.campaignId,
        renderKey,
      });
      return url;
    };
  }

  const result = await new PackageForPlatformUseCase(packageStore).execute({
    campaignId: slug,
    assets: parsed.assets,
    platforms,
    packagedAt: new Date().toISOString(),
    skipped: parsed.skipped,
    include,
    // Motion platforms are packageable only while the ffmpeg probe says so.
    capabilities: { motion: getCapabilities().motion },
    ...(publishClip ? { publishClip: true, clipPublisher } : {}),
  });
  if (!result.success) {
    setResponseStatus(event, 422);
    return { error: result.error.message };
  }
  return result.value;
});

/**
 * The s3 package store: reads renders from objects and writes each platform's
 * package to a fresh generation under the campaign's `packages/` prefix, made
 * live by the manifest written last (D209f). The caller has already resolved and
 * 404-guarded the `RenderTarget`, so the prefixes here are always well-formed.
 */
function objectPackageStoreFor(scope: TenantContext, target: RenderTarget): PackageStorePort {
  return new ObjectPackageStore(objectStoreClient(), {
    renderPrefix: renderPrefix(scope.orgId, target.campaignId),
    packagePrefix: packagePrefix(scope.orgId, target.campaignId),
    campaignSegment: target.slug,
    onSweepError: (error, platformId) => {
      // The package is committed by the time this can run, so it is reported and
      // not thrown — see `ObjectPackageStoreOptions.onSweepError`. The composition
      // root reports it rather than the adapter, because the adapter is in
      // Distribution and the logger is this app's.
      //
      // **The platform id and the message, and nothing this adapter knows.** A key
      // is `org/<orgId>/campaign/<uuid>/…` (DoD 3), so interpolating one here would
      // put a tenant's org id and campaign uuid into a log line — readable by
      // whoever reads logs, which is the one place they must not be. The message is
      // safe to interpolate because `S3RequestError` names only the operation, the
      // status and the body's `<Code>` (PT-4a's never-echo rule): a real bucket
      // refusal arrives here already stripped of the key it refused. So the line
      // below cannot carry one, and that holds because of a contract in
      // `S3ObjectStore`, not because this call site is careful.
      console.warn(
        `[package] could not sweep older generations for platform ${platformId}: ${errorMessage(error)}`,
      );
    },
  });
}

/**
 * Today's composite: renders are read through the OUTPUT store (so a run whose
 * renders were written by any backend is readable) and the package is staged and
 * swapped in on disk by `FileSystemPackageStore`. Verbatim under `fs`, because
 * under `fs` nothing about it needs to change and every byte of its output is a
 * package a customer has already received.
 */
function fsPackageStore(scope: TenantContext, slug: string): PackageStorePort {
  const outputStore = getOutputStore(scope);
  const fsPackageStore = new FileSystemPackageStore(storageRoots(scope).outputRoot, slug);
  return {
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
}
