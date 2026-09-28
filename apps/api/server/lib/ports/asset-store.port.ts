/**
 * Metadata for an asset stored under a campaign brief.
 */
export interface AssetEntry {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  readonly thumbnailUrl: string;
}

/**
 * Port for storing, retrieving, listing, and copying assets.
 *
 * Abstracts local filesystem storage under `assets/inputs/` so cloud storage
 * (e.g. S3 / Cloud Storage bucket) can be plugged in transparently.
 */
export interface AssetStorePort {
  /**
   * Store a PNG or JPEG asset for a brief exclusively.
   * Returns the repo-relative path `assets/inputs/<briefId>/<name>`.
   * Fails with EEXIST if an asset already exists at that path.
   */
  writeAsset(briefId: string, name: string, bytes: Buffer): Promise<{ path: string }>;

  /**
   * Read raw bytes of an asset stored under a campaign brief.
   * Returns undefined if missing or unreadable.
   */
  readAsset(briefId: string, name: string): Promise<Buffer | undefined>;

  /**
   * List assets available for a brief.
   * Returns empty array if no assets exist.
   */
  listAssets(briefId: string): Promise<readonly AssetEntry[]>;

  /**
   * Copy all brief-scoped assets from one brief to another (`fromBriefId` -> `toBriefId`).
   * Creates the target asset directory/prefix if missing. Preserves nested paths and disambiguates collisions.
   * Returns a map of relative source asset path -> relative destination asset path.
   */
  copyAssets(fromBriefId: string, toBriefId: string): Promise<Record<string, string>>;

  /**
   * Delete every asset stored under a brief (PT-5b2 fix-round item 2: undoing
   * a `copyAssets` this same request made into a slug whose `createCampaign`
   * reservation is about to be released, because a later step — the
   * additional-source visibility check, or the first-version `createBrief` —
   * failed). A no-op when the brief has no assets.
   */
  deleteAssets(briefId: string): Promise<void>;

  /**
   * Compute the canonical relative path for an asset (`assets/inputs/<briefId>/<name>`).
   */
  assetRelPath(briefId: string, name: string): string;
}
