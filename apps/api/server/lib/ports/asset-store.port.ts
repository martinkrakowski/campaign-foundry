import type { ObjectKey } from "@campaignfoundry/CampaignOrchestration";

/**
 * A bare uuid, in the one case Postgres renders an `asset.id` in (D203's shape
 * rule, C4's reference syntax).
 *
 * **Lower case, and that is LOAD-BEARING rather than tidy.** `asset.id` is a
 * `uuid` column (`0016_asset.sql`), so a ref bound to `a.id = $2` that is not a
 * uuid raises `22P02` on pg and on PGlite alike — and the adapter's promise for
 * "no such row" is `undefined`, not a throw. This guard is what keeps a
 * malformed ref a `undefined` instead of a 500. It is also why the `/i` flag of
 * `CAMPAIGN_UUID_PATTERN` (`object-asset-store.ts`) is NOT reused here: a
 * case-insensitive test admits an UPPER-case uuid, which no column can ever hold
 * and every driver rejects, so it converts the failure this function exists to
 * prevent back into a 500 for a strictly larger set of refs.
 *
 * **A path is anything else.** D203 makes shape the ONLY discriminator, so this
 * is what decides whether a stored ref is an id — and nothing else may decide it,
 * or a campaign named like a uuid becomes unreadable.
 */
const ASSET_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Whether a brief's stored ref is an ASSET ID rather than a path (PT-4k1, D203).
 *
 * Pure and import-free by design: it is the shape rule every layer asks (the
 * route's write-side checks in PT-4k2, `ObjectInputAssets`'s id branch, and the
 * adapters that must refuse a non-uuid before it reaches a query), and a second
 * copy of it is how an id and a path end up told apart two different ways.
 */
export function isAssetId(ref: string): boolean {
  return ASSET_ID_PATTERN.test(ref);
}

/**
 * Metadata for an asset stored under a campaign brief.
 *
 * `id` is the asset's own uuid, and it is OPTIONAL because only the Postgres
 * backend has one: `ObjectAssetStore` sets it on every entry, `FsAssetStore`
 * leaves it absent (there is no id on a filesystem, and inventing one here is
 * how a caller would start handing out refs nothing can read).
 */
export interface AssetEntry {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  readonly thumbnailUrl: string;
  readonly id?: string;
}

/**
 * The campaign an asset belongs to, as the write-side checks need it (PT-4k2
 * reads it through `assetOwner`; nothing above this line learns the query).
 *
 * `slug` and `name` together are what a brief written BEFORE ids carried as a
 * path — `assets/inputs/<slug>/<name>` — which is exactly what the copy map's
 * name entry remaps.
 */
export interface AssetOwner {
  readonly campaignId: string;
  readonly slug: string;
  readonly name: string;
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
   * Returns the repo-relative path `assets/inputs/<briefId>/<name>`, plus the
   * asset's own `id` on the backends that mint one (s3, PT-4k1) and no `id` on
   * fs. Fails with EEXIST if an asset already exists at that path.
   */
  writeAsset(briefId: string, name: string, bytes: Buffer): Promise<{ path: string; id?: string }>;

  /**
   * Read raw bytes of an asset stored under a campaign brief.
   * Returns undefined if missing or unreadable.
   */
  readAsset(briefId: string, name: string): Promise<Buffer | undefined>;

  /**
   * Read one asset's bytes by its id, org-scoped (PT-4k1, D208c).
   *
   * The id-addressed twin of {@link AssetStorePort.readAsset}, added rather than
   * folded into it: every signature above this line is one the routes and the
   * pipeline already call, and a ref that is an id is told from a ref that is a
   * path by {@link isAssetId} — never by the port guessing.
   *
   * `undefined` for a non-id, for an id no row in THIS org holds (another
   * tenant's id included, which must never surface as "forbidden"), and for a
   * row whose object is gone. A store that REFUSES propagates, as it does in
   * `readAsset`.
   */
  readAssetById(id: string): Promise<Buffer | undefined>;

  /**
   * The campaign and name behind an asset id, org-scoped, or `undefined`
   * (PT-4k1, D208c). The read half of what PT-4k2's save-time checks need, and
   * the reason an id ref can be turned back into the path a brief wrote before
   * ids existed.
   */
  assetOwner(id: string): Promise<AssetOwner | undefined>;

  /**
   * The object key holding one asset's bytes, or `undefined` (PT-4f, D209b).
   *
   * Added for the `?name=` redirect alone, and it is the smallest thing that can
   * answer it: `GET /campaigns/assets?name=` under `s3` answers 302 to a freshly
   * presigned location, which needs a KEY and nothing else — no bytes, no
   * metadata, no HEAD round-trip. An object missing behind a row that exists is
   * the store's own 404 after the redirect, which is a deliberate change from
   * `readAsset`'s.
   *
   * **It never checks that the object EXISTS.** A key is derived from a row, not
   * from a listing, so this stays one query on the backends that have rows and no
   * query at all on fs — and a second actor's write or delete between the lookup
   * and the browser's GET is the store's business, not a race this method could
   * close anyway.
   *
   * `undefined` for a back that has no keys at all (fs: an asset is named by its
   * path), for a reference that does not resolve, for a row this org does not
   * hold — another tenant's is ABSENT, never forbidden, exactly as
   * {@link AssetStorePort.readAssetById} answers — and for a name no row carries.
   */
  assetObjectKey(briefId: string, name: string): Promise<ObjectKey | undefined>;

  /**
   * List assets available for a brief.
   * Returns empty array if no assets exist.
   */
  listAssets(briefId: string): Promise<readonly AssetEntry[]>;

  /**
   * Copy all brief-scoped assets from one brief to another (`fromBriefId` -> `toBriefId`).
   * Creates the target asset directory/prefix if missing. Preserves nested paths and disambiguates collisions.
   * Returns a map of relative source asset path -> relative destination asset
   * path, plus — on the backends that have ids — the source asset's path and id
   * each mapped to the TARGET asset's id (PT-4k1).
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
