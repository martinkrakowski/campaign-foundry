import { ok, err, errorMessage, type Result } from "@campaignfoundry/shared";
import { platformProfile, type PlatformProfile } from "../../domain/value-objects/PlatformProfile.vo.js";
import type {
  PackageManifestItem,
  PackageStorePort,
} from "../ports/out/PackageStorePort.js";

/** The four fields packaging needs from a persisted report row. */
export interface PackageableAsset {
  readonly productId: string;
  readonly aspectRatio: string;
  readonly treatment: string;
  readonly outputPath: string;
}

export interface PackageForPlatformInput {
  readonly campaignId: string;
  readonly assets: readonly PackageableAsset[];
  readonly platforms: readonly string[];
  /** ISO-8601 timestamp from the composition root's clock — never `new Date()` here. */
  readonly packagedAt: string;
  /** Report rows that failed the persisted-asset guard; counted on every platform manifest. */
  readonly skipped?: number;
}

export interface PackagedPlatform {
  readonly platformId: string;
  readonly manifestPath: string;
  readonly items: readonly PackageManifestItem[];
  readonly skipped: number;
}

export interface PackageForPlatformResult {
  readonly platforms: readonly PackagedPlatform[];
}

/** Drop absolute paths (quoted or bare, POSIX or Windows) so a 422 never leaks the server tree. */
export function withoutAbsolutePaths(message: string): string {
  return message.replace(/(^|[\s'"])(?:[A-Za-z]:)?(?:\/|\\)[^\s'"]+/g, "$1<path>");
}

/**
 * PackageForPlatformUseCase — copy matching-ratio statics into per-platform
 * folders. Never re-renders. Hidden / unknown platform ids fail the whole request.
 * Store failures are caught per platform and returned as err; they never throw.
 */
export class PackageForPlatformUseCase {
  constructor(private readonly store: PackageStorePort) {}

  async execute(input: PackageForPlatformInput): Promise<Result<PackageForPlatformResult, Error>> {
    const profiles: Array<{ platformId: string; profile: PlatformProfile }> = [];
    for (const platformId of input.platforms) {
      const profile = platformProfile(platformId);
      if (!profile) return err(new Error(`Unknown platform "${platformId}"`));
      if (!profile.visible) return err(new Error(`Platform "${platformId}" is not visible`));
      profiles.push({ platformId, profile });
    }

    const skipped = input.skipped ?? 0;
    const platforms: PackagedPlatform[] = [];
    for (const { platformId, profile } of profiles) {
      try {
        // Assets have no format field yet — treat every generated creative as static.
        const selected = input.assets.filter((asset) => asset.aspectRatio === profile.ratio);
        const items: PackageManifestItem[] = [];
        for (const asset of selected) {
          const bytes = await this.store.readAsset(asset.outputPath);
          const size = bytes.length <= profile.maxBytes ? "pass" : "fail";
          const packagedPath = await this.store.writePackaged(platformId, asset.outputPath, bytes);
          items.push({
            productId: asset.productId,
            aspectRatio: asset.aspectRatio,
            treatment: asset.treatment,
            source: asset.outputPath,
            packagedPath,
            bytes: bytes.length,
            checks: { size },
          });
        }

        const manifestPath = await this.store.writeManifest(platformId, {
          campaignId: input.campaignId,
          platformId,
          packagedAt: input.packagedAt,
          skipped,
          profile,
          items,
        });
        platforms.push({ platformId, manifestPath, items, skipped });
      } catch (error) {
        return err(new Error(`Platform "${platformId}": ${withoutAbsolutePaths(errorMessage(error))}`));
      }
    }

    return ok({ platforms });
  }
}
