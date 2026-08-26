import type { PlatformProfile } from "../../../domain/value-objects/PlatformProfile.vo.js";

/** One copied creative in a platform package. */
export interface PackageManifestItem {
  readonly productId: string;
  readonly aspectRatio: string;
  readonly treatment: string;
  readonly source: string;
  readonly packagedPath: string;
  readonly bytes: number;
  readonly checks: { readonly size: "pass" | "fail" };
}

/**
 * Written to packages/<campaignId>/<platformId>/manifest.json — never re-rendered.
 * `packagedAt` is the clock reading from the composition root; the package is the
 * current output for that report (renders are not campaign-namespaced).
 */
export interface PackageManifest {
  readonly campaignId: string;
  readonly platformId: string;
  readonly packagedAt: string;
  readonly skipped: number;
  /** Ratio-matching assets kept / dropped by the caller's `include` list (0 excluded when omitted). */
  readonly included: number;
  readonly excluded: number;
  readonly profile: PlatformProfile;
  readonly items: readonly PackageManifestItem[];
}

/**
 * PackageStorePort — copy already-rendered creatives into a per-platform folder
 * and persist the manifest. The adapter resolves paths; the use case never
 * touches the filesystem.
 */
export interface PackageStorePort {
  /** Read a source creative relative to the output root (GeneratedAsset.outputPath). */
  readAsset(relativePath: string): Promise<Uint8Array>;
  /**
   * Write bytes under output/packages/<campaignId>/<platformId>/.
   * Returns a path relative to the output root. Must refuse `..`.
   */
  writePackaged(platformId: string, relativePath: string, bytes: Uint8Array): Promise<string>;
  /** Persist manifest.json for a platform; returns its output-root-relative path. */
  writeManifest(platformId: string, manifest: PackageManifest): Promise<string>;
}
