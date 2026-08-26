import { ok, err, type Result } from "@campaignfoundry/shared";
import type { GeneratedAsset } from "@campaignfoundry/CampaignOrchestration";
import { platformProfile, type PlatformProfile } from "../../domain/value-objects/PlatformProfile.vo.js";
import type {
  PackageManifestItem,
  PackageStorePort,
} from "../ports/out/PackageStorePort.js";

export interface PackageForPlatformInput {
  readonly campaignId: string;
  readonly assets: readonly GeneratedAsset[];
  readonly platforms: readonly string[];
}

export interface PackagedPlatform {
  readonly platformId: string;
  readonly manifestPath: string;
  readonly items: readonly PackageManifestItem[];
}

export interface PackageForPlatformResult {
  readonly platforms: readonly PackagedPlatform[];
}

/**
 * PackageForPlatformUseCase — copy matching-ratio statics into per-platform
 * folders. Never re-renders. Hidden / unknown platform ids fail the whole request.
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

    const platforms: PackagedPlatform[] = [];
    for (const { platformId, profile } of profiles) {
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
        profile,
        items,
      });
      platforms.push({ platformId, manifestPath, items });
    }

    return ok({ platforms });
  }
}
