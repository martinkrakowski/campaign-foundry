import { assetIdentity } from "@campaignfoundry/CampaignOrchestration";
import { ok, err, errorMessage, type Result } from "@campaignfoundry/shared";
import {
  isPlatformVisible,
  platformProfile,
  type PlatformCapabilities,
  type PlatformProfile,
} from "../../domain/value-objects/PlatformProfile.vo.js";
import type {
  PackageManifestItem,
  PackageStorePort,
} from "../ports/out/PackageStorePort.js";

/** The fields packaging needs from a persisted report row (`variantIndex` only on variation rows). */
export interface PackageableAsset {
  readonly productId: string;
  readonly aspectRatio: string;
  readonly treatment: string;
  /** The PNG — the poster on motion rows. */
  readonly outputPath: string;
  readonly variantIndex?: number;
  /** Absent on classic rows (static). */
  readonly format?: "static" | "motion";
  /** The mp4 — motion rows only. */
  readonly videoPath?: string;
  readonly durationSec?: number;
}

export interface PackageForPlatformInput {
  readonly campaignId: string;
  readonly assets: readonly PackageableAsset[];
  readonly platforms: readonly string[];
  /** ISO-8601 timestamp from the composition root's clock — never `new Date()` here. */
  readonly packagedAt: string;
  /** Report rows that failed the persisted-asset guard; counted on every platform manifest. */
  readonly skipped?: number;
  /**
   * Asset identities (`assetIdentity`) to package — the HITL-approved set. Omitted
   * means every asset; an empty list packages nothing.
   */
  readonly include?: readonly string[];
  /** Host capabilities; motion platforms are visible only with `motion: true`. Default: static only. */
  readonly capabilities?: PlatformCapabilities;
}

export interface PackagedPlatform {
  readonly platformId: string;
  readonly manifestPath: string;
  readonly items: readonly PackageManifestItem[];
  readonly skipped: number;
  readonly included: number;
  readonly excluded: number;
}

export interface PackageForPlatformResult {
  readonly platforms: readonly PackagedPlatform[];
}

/** Drop absolute paths (quoted or bare, POSIX or Windows) so a 422 never leaks the server tree. */
export function withoutAbsolutePaths(message: string): string {
  return message.replace(/(^|[\s'"])(?:[A-Za-z]:)?(?:\/|\\)[^\s'"]+/g, "$1<path>");
}

/** Motion rows carry an mp4; anything else (classic rows have no `format`) is a static. */
const isMotionAsset = (asset: PackageableAsset): asset is PackageableAsset & { videoPath: string } =>
  asset.format === "motion" && typeof asset.videoPath === "string";

/**
 * PackageForPlatformUseCase — copy matching-ratio creatives into per-platform
 * folders: statics for static profiles, mp4 + poster for motion profiles.
 * Never re-renders. Hidden / unknown platform ids fail the whole request.
 * Store failures are caught per platform and returned as err; they never throw.
 */
export class PackageForPlatformUseCase {
  constructor(private readonly store: PackageStorePort) {}

  async execute(input: PackageForPlatformInput): Promise<Result<PackageForPlatformResult, Error>> {
    const capabilities = input.capabilities ?? { motion: false };
    const profiles: Array<{ platformId: string; profile: PlatformProfile }> = [];
    for (const platformId of input.platforms) {
      const profile = platformProfile(platformId);
      if (!profile) return err(new Error(`Unknown platform "${platformId}"`));
      if (!isPlatformVisible(profile, capabilities)) {
        return err(new Error(`Platform "${platformId}" is not visible`));
      }
      profiles.push({ platformId, profile });
    }

    const skipped = input.skipped ?? 0;
    const include = input.include === undefined ? null : new Set(input.include);
    const platforms: PackagedPlatform[] = [];
    for (const { platformId, profile } of profiles) {
      try {
        // A motion profile takes motion rows; a static profile ignores them.
        const wantsMotion = profile.formats.includes("motion");
        const eligible = input.assets.filter(
          (asset) => asset.aspectRatio === profile.ratio && isMotionAsset(asset) === wantsMotion,
        );
        const selected = include === null ? eligible : eligible.filter((a) => include.has(assetIdentity(a)));
        const included = selected.length;
        const excluded = eligible.length - selected.length;
        const items: PackageManifestItem[] = [];
        for (const asset of selected) {
          items.push(
            isMotionAsset(asset)
              ? await this.packageMotion(platformId, profile, asset)
              : await this.packageStatic(platformId, profile, asset),
          );
        }

        const manifestPath = await this.store.writeManifest(platformId, {
          campaignId: input.campaignId,
          platformId,
          packagedAt: input.packagedAt,
          skipped,
          included,
          excluded,
          profile,
          items,
        });
        platforms.push({ platformId, manifestPath, items, skipped, included, excluded });
      } catch (error) {
        return err(new Error(`Platform "${platformId}": ${withoutAbsolutePaths(errorMessage(error))}`));
      }
    }

    return ok({ platforms });
  }

  private async packageStatic(
    platformId: string,
    profile: PlatformProfile,
    asset: PackageableAsset,
  ): Promise<PackageManifestItem> {
    const bytes = await this.store.readAsset(asset.outputPath);
    const packagedPath = await this.store.writePackaged(platformId, asset.outputPath, bytes);
    return {
      productId: asset.productId,
      aspectRatio: asset.aspectRatio,
      treatment: asset.treatment,
      format: "static",
      source: asset.outputPath,
      packagedPath,
      bytes: bytes.length,
      checks: { size: bytes.length <= profile.maxBytes ? "pass" : "fail" },
    };
  }

  /** The mp4 is the item (size + duration checks); its poster rides along. */
  private async packageMotion(
    platformId: string,
    profile: PlatformProfile,
    asset: PackageableAsset & { videoPath: string },
  ): Promise<PackageManifestItem> {
    const video = await this.store.readAsset(asset.videoPath);
    const poster = await this.store.readAsset(asset.outputPath);
    const packagedPath = await this.store.writePackaged(platformId, asset.videoPath, video);
    const posterPath = await this.store.writePackaged(platformId, asset.outputPath, poster);
    const duration =
      asset.durationSec !== undefined &&
      (profile.maxDurationSec === undefined || asset.durationSec <= profile.maxDurationSec)
        ? "pass"
        : "fail";
    return {
      productId: asset.productId,
      aspectRatio: asset.aspectRatio,
      treatment: asset.treatment,
      format: "motion",
      source: asset.videoPath,
      packagedPath,
      posterPath,
      ...(asset.durationSec !== undefined ? { durationSec: asset.durationSec } : {}),
      bytes: video.length,
      checks: { size: video.length <= profile.maxBytes ? "pass" : "fail", duration },
    };
  }
}
