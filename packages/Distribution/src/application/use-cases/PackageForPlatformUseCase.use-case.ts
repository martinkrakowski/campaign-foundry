import {
  assetIdentity,
  CLICK_TAG_VARIABLE,
  isExpired,
  parseExpiresOnMs,
  type AudioRights,
} from "@campaignfoundry/CampaignOrchestration";
import { ok, err, errorMessage, type Result } from "@campaignfoundry/shared";
import {
  isPlatformVisible,
  platformProfile,
  type PlatformCapabilities,
  type PlatformProfile,
} from "../../domain/value-objects/PlatformProfile.vo.js";
import type { PackageManifestItem, PackageStorePort } from "../ports/out/PackageStorePort.js";

/** The fields packaging needs from a persisted report row (`variantIndex` only on variation rows). */
export interface PackageableAsset {
  readonly productId: string;
  /** The social canvas. Display rows carry `size` instead (D113) — exactly one of the two. */
  readonly aspectRatio?: string;
  /** The display family's canvas (the `728x90` form); ratio rows omit it. */
  readonly size?: string;
  readonly treatment: string;
  /** The PNG — the poster on motion rows. */
  readonly outputPath: string;
  readonly variantIndex?: number;
  /** Absent on classic rows (static). */
  readonly format?: "static" | "motion" | "html";
  /** The mp4 — motion rows only. */
  readonly videoPath?: string;
  /** The HTML bundle — html rows only. */
  readonly htmlBundlePath?: string;
  /** The required raster fallback rendition (D122) — html rows only. */
  readonly htmlFallbackPath?: string;
  /** The click destination URL (HL2, HL-D3). */
  readonly clickDestination?: string;
  readonly durationSec?: number;
  /**
   * Music rights record (VE-D8). Packaging never re-renders (D11) and may run
   * well after the licence expired, so `expiresOn` is re-checked here against
   * `packagedAt` rather than trusted from the run that produced the asset.
   */
  readonly audioRights?: AudioRights;
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
  /** The brief's click destination URL (HL2, HL-D3). */
  readonly clickDestination?: string;
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
const isMotionAsset = (
  asset: PackageableAsset,
): asset is PackageableAsset & { videoPath: string } =>
  asset.format === "motion" && typeof asset.videoPath === "string";

/** HTML rows carry a bundle and its raster fallback rendition (D122). */
const isHtmlAsset = (
  asset: PackageableAsset,
): asset is PackageableAsset & { htmlBundlePath: string; htmlFallbackPath: string } =>
  asset.format === "html" &&
  typeof asset.htmlBundlePath === "string" &&
  typeof asset.htmlFallbackPath === "string";

/**
 * PackageForPlatformUseCase — copy matching-canvas creatives into per-platform
 * folders: social profiles match by ratio, display profiles by size (D116);
 * statics for static profiles, mp4 + poster for motion profiles, bundle + raster
 * fallback for html profiles (D122). Never re-renders. Hidden / unknown
 * platform ids fail the whole request. A display profile whose run produced no
 * size assets fails loudly — a successful empty manifest is the D8 dead end, not
 * a result. Store failures are caught per platform and returned as err; they
 * never throw.
 */
export class PackageForPlatformUseCase {
  constructor(
    private readonly store: PackageStorePort,
    /** Profile lookup — injected so tests can register a profile that declares `html` (none ships one yet, D122). */
    private readonly resolveProfile: (
      platformId: string,
    ) => PlatformProfile | undefined = platformProfile,
  ) {}

  async execute(input: PackageForPlatformInput): Promise<Result<PackageForPlatformResult, Error>> {
    const capabilities = input.capabilities ?? { motion: false };
    // D122: an HTML unit always carries a raster fallback rendition — an asset that
    // names the format without the field is invalid and refuses the whole request.
    const withoutFallback = input.assets.find(
      (asset) => asset.format === "html" && typeof asset.htmlFallbackPath !== "string",
    );
    if (withoutFallback) {
      return err(
        new Error(
          `HTML asset ${assetIdentity(withoutFallback)} is missing its required raster fallback rendition ("htmlFallbackPath").`,
        ),
      );
    }
    const profiles: Array<{ platformId: string; profile: PlatformProfile }> = [];
    for (const platformId of input.platforms) {
      const profile = this.resolveProfile(platformId);
      if (!profile) return err(new Error(`Unknown platform "${platformId}"`));
      if (!isPlatformVisible(profile, capabilities)) {
        return err(new Error(`Platform "${platformId}" is not visible`));
      }
      profiles.push({ platformId, profile });
    }

    const include = input.include === undefined ? null : new Set(input.include);

    // Resolve, per platform, exactly which assets are eligible and selected —
    // before any I/O and before the expiry check below (VE-D8 fix2 #5): a
    // licence's expiry must be judged only against assets that will actually be
    // packaged for the requested platforms, never a row a platform's
    // format/canvas match (or the HITL `include` set) was always going to drop.
    const selections: Array<{
      platformId: string;
      profile: PlatformProfile;
      eligible: PackageableAsset[];
      selected: PackageableAsset[];
    }> = [];
    for (const { platformId, profile } of profiles) {
      try {
        // A profile takes the rows of its declared formats and ignores the others:
        // a motion profile takes motion rows, an html profile takes html rows, a
        // static profile takes the rest — exactly how motion rows are skipped by a
        // static profile today.
        // The canvas match follows the profile's family: a social profile takes
        // rows at its ratio, a display profile takes rows whose size is one of
        // the units it accepts (D116) — a ratio row never matches a display
        // profile, and a size row never matches a social one.
        const wantsMotion = profile.formats.includes("motion");
        const wantsHtml = profile.formats.includes("html");
        const wantsStatic = profile.formats.includes("static");
        const eligible = input.assets.filter((asset) => {
          if (isMotionAsset(asset)) {
            if (!wantsMotion) return false;
          } else if (isHtmlAsset(asset)) {
            // D161: the bundle belongs to an html profile. A display static
            // profile (it matches sizes, not a social ratio) packages the same
            // row's raster fallback. A social static profile does not.
            if (!wantsHtml && !(wantsStatic && profile.sizes !== undefined)) return false;
          } else if (!wantsStatic) {
            return false;
          }
          if (profile.sizes === undefined) return asset.aspectRatio === profile.ratio;
          return asset.size !== undefined && profile.sizes.some((slot) => slot.size === asset.size);
        });
        const selected =
          include === null ? eligible : eligible.filter((a) => include.has(assetIdentity(a)));
        // A display profile with nothing to package means the run was generated
        // without `output.sizes` (or for the wrong sizes) — or that the HITL
        // `include` set left nothing for it. The guard is applied to the
        // SELECTION, not to eligibility (X14 fix2): a rejected-but-eligible row
        // must not satisfy the check so the later `include` filter can still
        // write a successful manifest with `items: []`. A successful empty
        // manifest would send the buyer an empty package — say so instead.
        if (profile.sizes !== undefined && selected.length === 0) {
          throw new Error(
            `no display assets for ${platformId} — was the campaign generated with output.sizes?`,
          );
        }
        selections.push({ platformId, profile, eligible, selected });
      } catch (error) {
        return err(
          new Error(`Platform "${platformId}": ${withoutAbsolutePaths(errorMessage(error))}`),
        );
      }
    }

    // VE-D8: expiry is re-checked here, against this run's `packagedAt`, because
    // packaging never re-renders (D11) and can happen well after the licence the
    // legal gate cleared has lapsed. Checked only against assets selected above —
    // a rights-bearing row a platform's format/canvas match or `include` drops is
    // never packaged, so its expiry cannot block a package it plays no part in.
    // Nothing is warned-and-packaged — the whole request refuses, exactly like
    // the missing-fallback guard above. `packagedAt` is the composition root's
    // own ISO-8601 timestamp (never a brief value), so it is parsed with
    // `Date.parse` directly rather than the stricter `parseExpiresOnMs` a
    // brief-supplied `expiresOn` must pass — but a value that fails to parse
    // fails CLOSED (the request is refused) rather than silently comparing
    // against `NaN`, where every expiry check reads "not expired" (fix2 #6).
    const packagedAtMs = Date.parse(input.packagedAt);
    if (!Number.isFinite(packagedAtMs)) {
      return err(
        new Error(
          `Package request's "packagedAt" is not a valid timestamp; got ${JSON.stringify(input.packagedAt)}.`,
        ),
      );
    }
    // Every selected asset, never deduplicated by `assetIdentity` (VE3a fix3):
    // the route accepts separate persisted rows without enforcing unique
    // identities, so keying a Map by identity let a later same-identity row
    // silently replace an earlier expired one HERE while the packaging loop
    // below still writes every row `selected` names. A duplicate object
    // reference (the same asset selected for two platforms) is simply
    // checked twice — harmless, since the check is pure.
    const toPackage: PackageableAsset[] = [];
    for (const { selected } of selections) {
      toPackage.push(...selected);
    }
    const expiredAsset = toPackage.find((asset) => {
      const expiresOn = asset.audioRights?.expiresOn;
      if (expiresOn === undefined) return false;
      const expiresMs = parseExpiresOnMs(expiresOn);
      return expiresMs !== undefined && isExpired(expiresMs, packagedAtMs);
    });
    if (expiredAsset) {
      return err(
        new Error(
          `Asset ${assetIdentity(expiredAsset)} has a music licence ("${expiredAsset.audioRights?.licenceId}") that expired before this package's packagedAt.`,
        ),
      );
    }

    const skipped = input.skipped ?? 0;
    const platforms: PackagedPlatform[] = [];
    for (const { platformId, profile, eligible, selected } of selections) {
      try {
        const included = selected.length;
        const excluded = eligible.length - selected.length;
        const items: PackageManifestItem[] = [];
        for (const asset of selected) {
          items.push(
            isMotionAsset(asset)
              ? await this.packageMotion(platformId, profile, asset)
              : isHtmlAsset(asset) && profile.formats.includes("html")
                ? await this.packageHtml(platformId, profile, asset, input.clickDestination)
                : isHtmlAsset(asset) &&
                    profile.formats.includes("static") &&
                    profile.sizes !== undefined
                  ? await this.packageStatic(platformId, profile, {
                      ...asset,
                      outputPath: asset.htmlFallbackPath,
                    })
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
        return err(
          new Error(`Platform "${platformId}": ${withoutAbsolutePaths(errorMessage(error))}`),
        );
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
      // Exactly one of the two is defined on any real row (D113); undefined keys
      // drop from the serialized manifest, so each item names its own family.
      aspectRatio: asset.aspectRatio,
      size: asset.size,
      treatment: asset.treatment,
      format: "static",
      source: asset.outputPath,
      packagedPath,
      bytes: bytes.length,
      checks: { size: bytes.length <= profile.maxBytes ? "pass" : "fail" },
    };
  }

  /**
   * The mp4 is the item (size + duration checks); its poster rides along.
   */
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
      size: asset.size,
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

  /**
   * The bundle is the item (size check); its raster fallback rides along (D122).
   * Markup is never rasterised, so no pixel hash is recorded for it — verification
   * is structural (the bundle parses, references resolve, the fallback exists).
   */
  private async packageHtml(
    platformId: string,
    profile: PlatformProfile,
    asset: PackageableAsset & { htmlBundlePath: string; htmlFallbackPath: string },
    briefDestination?: string,
  ): Promise<PackageManifestItem> {
    const bundle = await this.store.readAsset(asset.htmlBundlePath);
    const destination = asset.clickDestination ?? briefDestination;
    if (destination !== undefined) {
      const bundleText = new TextDecoder().decode(bundle);
      if (!bundleText.includes(CLICK_TAG_VARIABLE)) {
        throw new Error(
          `HTML asset ${assetIdentity(asset)} has clickDestination but bundle is missing "${CLICK_TAG_VARIABLE}" variable declaration.`,
        );
      }
    }
    const fallback = await this.store.readAsset(asset.htmlFallbackPath);
    const packagedPath = await this.store.writePackaged(platformId, asset.htmlBundlePath, bundle);
    const fallbackPath = await this.store.writePackaged(
      platformId,
      asset.htmlFallbackPath,
      fallback,
    );
    // The budget is the unit's, and the unit a network measures is the package it
    // uploads: `index.html` *and* its raster fallback. Counting the bundle alone
    // would pass a unit whose fallback pushes it over (X14).
    const unitBytes = bundle.length + fallback.length;
    return {
      productId: asset.productId,
      aspectRatio: asset.aspectRatio,
      size: asset.size,
      treatment: asset.treatment,
      format: "html",
      source: asset.htmlBundlePath,
      packagedPath,
      fallbackPath,
      bytes: bundle.length,
      checks: { size: unitBytes <= profile.maxBytes ? "pass" : "fail" },
    };
  }
}
