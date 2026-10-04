import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import type { ParseBriefOptions } from "../load-brief.js";

/**
 * A brief as persisted in storage with its metadata.
 * `campaignId` is the campaign surrogate uuid (Postgres) or slug (filesystem, D179).
 * `file` identifies the stored object/key; `revision` is its SHA-256 content digest.
 */
export interface StoredBrief {
  readonly campaignId: string;
  readonly file: string;
  readonly brief: CampaignBrief;
  readonly revision: string;
}

/**
 * A campaign reference resolved to its immutable surrogate id and slug (D178, D179).
 */
export interface ResolvedCampaign {
  readonly campaignId: string;
  readonly slug: string;
}

/**
 * `createCampaign`'s own options (D177, PT-5b2): a fresh mint has no
 * revision to guard, so it takes only the team a caller who already ran
 * `canAssignTeam` authorized — same meaning as `BriefWriteOptions.teamId`.
 * `name` and `type` (PT-5b3, D168, D177) are the display name and campaign
 * type the user typed at Create: a blank Create mints no version, so these
 * are the only place they are recorded until the first Save. `type` is a
 * sourced create's SOURCE type (the route reads it off the copied brief),
 * never the caller's own; a blank create's `type` is whatever the caller
 * validated against `CAMPAIGN_TYPES` (or omitted).
 */
export interface CreateCampaignOptions {
  readonly teamId?: string | null;
  readonly name?: string;
  readonly type?: string;
}

/**
 * A campaign's own display name, type and whether it has any saved version
 * (PT-5b3, D168, D177): `GET /campaigns/:id`'s answer for a campaign that
 * exists, versioned or not. `campaignId` echoes what `resolveCampaign` would
 * (the uuid on Postgres, `ref` itself on fs, D179), so a caller needs no
 * second resolve. `name`/`type` are null for a campaign minted before this
 * lane, or for an fs reservation with no recorded meta. `undefined` only
 * when `ref` (a uuid or a slug) names no campaign this caller may see —
 * absent or hidden by team (D166), indistinguishable on purpose (PT-2d).
 */
export interface CampaignMeta {
  readonly campaignId: string;
  readonly slug: string;
  readonly name: string | null;
  readonly type: string | null;
  readonly hasVersion: boolean;
}

/**
 * Team assignment options shared by `createBrief`, `rewriteBrief` and
 * `replaceBrief` (D166, PT-2c item 4). `teamId` is Postgres-only: `undefined`
 * means "leave as it is" for a rewrite/replace, or "no team" (null) for a
 * fresh create; an explicit value (a team id, or `null` to clear) is a
 * caller-authorized assignment. A backend with no team column (the
 * filesystem store) throws `TeamsNotSupportedError` for any non-undefined
 * `teamId` rather than silently ignoring it.
 */
export interface BriefWriteOptions {
  readonly expectedRevision?: string;
  readonly teamId?: string | null;
}

/**
 * Thrown when `teamId` is passed to a backend with no team column (the
 * filesystem store, D166 item 5): teams are Postgres-only. Carries
 * statusCode 400 so routes map it without an `instanceof` check on the
 * concrete adapter (`.agents/architecture.md`).
 */
export class TeamsNotSupportedError extends Error {
  readonly statusCode = 400;
  readonly status = 400;

  constructor() {
    // Product-facing text (the editor shows this API error unchanged, D166
    // qodo thread U1be) — never name the concrete storage backend here.
    super("Assigning a team isn't supported in this workspace.");
    this.name = "TeamsNotSupportedError";
  }
}

/**
 * Port for loading, finding, listing, creating, and updating campaign briefs.
 *
 * This port is the boundary between the HTTP routes / application layer and
 * the underlying storage mechanism (local filesystem today, S3/blob storage next).
 * No node:fs, path joining, or process.cwd() may leak through this interface.
 */
export interface BriefStorePort {
  /**
   * Cheap, synchronous capability flag (D166 item 4): true only for a backend
   * that can assign a team and therefore answer `campaignVisibility` with
   * "hidden" (`PgBriefStore`). `lib/ownership.ts`'s `campaignKnown` gates its
   * `campaignVisibility` call on this rather than calling it unconditionally,
   * so the filesystem backend's read path never pays for a directory scan it
   * cannot need an answer from (L1) — `campaignVisibility` itself would still
   * answer correctly (never "hidden") if called, this only skips the call.
   */
  readonly supportsTeams: boolean;

  /**
   * List all campaign briefs in the store.
   * Malformed or unparseable files are skipped.
   */
  listBriefs(): Promise<readonly StoredBrief[]>;

  /**
   * Find a brief by its domain identifier (`brief.id`).
   * Returns undefined if no brief with that id exists.
   */
  findBriefById(id: string): Promise<StoredBrief | undefined>;

  /**
   * Find a brief's storage key / file name by its domain identifier (`brief.id`).
   */
  findBriefFileById(id: string): Promise<string | undefined>;

  /**
   * Find a brief file by exact id / filename across allowed extensions.
   */
  findBriefFile(id: string, exts?: readonly string[]): Promise<string | undefined>;

  /**
   * Read and parse a brief by file name / key or path.
   */
  readBrief(fileOrKey: string, opts?: ParseBriefOptions): Promise<CampaignBrief>;

  /**
   * Exclusively create a new brief in storage.
   * Fails with an EEXIST error if a brief or file with the same id already exists,
   * UNLESS that row is a `createCampaign` mint with no version yet (D177,
   * PT-5b2): this write is then its first Save, adding version 1 to the
   * existing row rather than refusing the slug as taken. A row hidden from
   * this caller by team (D166) is refused as EEXIST either way, never
   * written into.
   * `options.teamId` (D166 item 4): see `BriefWriteOptions`.
   */
  createBrief(brief: CampaignBrief, options?: BriefWriteOptions): Promise<StoredBrief>;

  /**
   * Mint a campaign with no version yet (D177: Create mints the campaign
   * row; version 1 is the first Save) — the blank-create path of
   * `POST /campaigns` (PT-5b2). A Postgres row with no `brief_version`, or a
   * reserved `briefs/<slug>/` directory on the filesystem backend (D179: the
   * fs id IS the slug). Fails with an EEXIST error if the slug already names
   * a campaign (any state: versionless, versioned, or a plain brief file) or
   * a reserved directory on fs — the caller's own dedupe loop retries the
   * next suffix on that signal, the same one two concurrent callers of the
   * same name race on, rather than a separate check-then-act read.
   */
  createCampaign(slug: string, options?: CreateCampaignOptions): Promise<ResolvedCampaign>;

  /**
   * Undo a `createCampaign` reservation that a later step (asset copy, the
   * first-version `createBrief`) failed to complete (PT-5b2 fix-round item
   * 2): deletes the Postgres row, or removes the fs reserved directory,
   * ONLY if it still holds no version/brief — never touches one a
   * concurrent writer's own Save has since completed. Answers whether it
   * actually removed anything.
   *
   * **That answer no longer tells a caller whether to free copied assets.**
   * It used to, and it was the wrong way round: by the time it answers, the
   * decision has already been made too late — the assets have to be freed
   * BEFORE the release, because on s3 a freed-by-slug store resolves the
   * slug into the uuid its key prefix is built from and can only do so
   * while this row still exists (PT-4b). So a caller that wants the assets
   * gone reads `campaignMeta(slug)?.hasVersion` first and frees only while
   * that is false — which is the same "any version yet" test this method
   * guards on, asked once, in the only order in which the answer can still
   * change what happens. Freeing unconditionally is a data-loss race, not a
   * leak: `withBriefLock` is in-process, so a second API instance can win
   * this slug between the create and the failure, and an unconditional free
   * then empties the WINNER's uploads before this call goes on to refuse.
   *
   * On fs, delete the campaign's pool first (`deletePool`, a no-op when
   * absent): the pool file lives inside the same reserved directory this
   * removes, and removing a non-empty directory must fail closed, not
   * silently take the pool with it.
   */
  releaseCampaign(slug: string): Promise<boolean>;

  /**
   * Rewrite an existing brief in its own format.
   * If expectedRevision is provided, verifies revision match before writing;
   * otherwise throws an error with code ECONFLICT.
   * `options.teamId` (D166 item 4): see `BriefWriteOptions`.
   */
  rewriteBrief(brief: CampaignBrief, options?: BriefWriteOptions): Promise<StoredBrief>;

  /**
   * Replace an existing brief or create it if missing (used for ?replace=1).
   * `options.teamId` (D166 item 4): see `BriefWriteOptions`.
   */
  replaceBrief(brief: CampaignBrief, options?: BriefWriteOptions): Promise<StoredBrief>;

  /**
   * Compute the revision hash of a brief file / key.
   */
  getRevision(fileOrId: string): Promise<string | undefined>;

  /**
   * True if a brief or file exists at the given file name, key, or path.
   */
  exists(fileOrId: string): Promise<boolean>;

  /**
   * Whether a campaign is unknown ("absent"), visible to the caller
   * ("visible"), or exists but is hidden from the caller by team or tombstone
   * (D166, D233) — "hidden" only ever from `PgBriefStore`, since the
   * filesystem store has no team column (item 5) and never distinguishes
   * hidden from absent. Used by `lib/ownership.ts` (fail closed on a storage
   * failure — see D166 item 1) and by the brief write routes to answer 404/409
   * on a hidden or existing target before any write or asset copy runs.
   *
   * A tombstoned campaign (D231's `campaign.deleted_at`) is "hidden", never
   * "absent": `campaignKnown` reads "absent" as "never created" and falls
   * through to its slug-keyed `report`/`asset`/`pool`/`job` fallback, and those
   * rows are keyed by whichever ref the caller used (D246) — so "absent" would
   * keep serving a deleted, ever-generated campaign's report.
   *
   * A ref that is a CANONICAL UUID naming a row that is tombstoned or hidden by
   * team answers "hidden" WITHOUT being retried as a slug. It does not change
   * what any caller receives (each already turns "hidden" into the same single
   * 404 it turns a by-team "hidden" into), only which rows answer which of the
   * two, so the port's contract states it: `id` and `slug` share one text space,
   * so a uuid-shaped ref may be nobody's id and somebody's slug — but a ref that
   * reached this method as a uuid found no row under it, which is the one case
   * that IS genuinely absent.
   */
  campaignVisibility(id: string): Promise<"absent" | "visible" | "hidden">;

  /**
   * Execute a critical section with per-brief concurrency locking.
   */
  withBriefLock<T>(briefId: string, fn: () => Promise<T>): Promise<T>;

  /**
   * Resolve a campaign reference (canonical uuid OR slug) within the caller's scope (D178, D179).
   * If `ref` matches a canonical uuid shape, resolves by id first, then falls back to slug.
   * Answers `{ campaignId, slug }` or `undefined` if absent or hidden by team.
   */
  resolveCampaign(ref: string): Promise<ResolvedCampaign | undefined>;

  /**
   * A campaign's own team assignment, for a caller that already resolved and
   * owns it (duplicate, a sourced `POST /campaigns`, PT-5b2 fix-round item
   * 1): `null` for org-wide, a team id, or `undefined` when the slug is
   * absent or hidden from this caller by team. A copy with no explicit
   * `teamId` inherits this value, so a member's team-scoped source never
   * becomes an org-wide copy by omission — the same visibility the caller
   * could already see, carried forward, no extra permission check needed.
   * The fs backend has no team column (D166 item 5): `null` when the brief
   * exists, `undefined` otherwise.
   */
  campaignTeam(slug: string): Promise<string | null | undefined>;

  /**
   * Resolve `ref` (a uuid or a slug, D178, D179) to its display name, type
   * and whether it has a saved version — see `CampaignMeta`. `undefined` for
   * a ref absent or hidden by team; never throws for an unknown ref.
   */
  campaignMeta(ref: string): Promise<CampaignMeta | undefined>;

  /**
   * Whether `id` names a campaign with REAL evidence behind it — a saved
   * version, or a genuine record `createCampaign` itself wrote — visible to
   * this caller (D181 fix round 2). Used only to grandfather a RESERVED
   * slug's first Save: `campaignMeta`'s own fs fallback trusts a bare
   * `briefs/<id>/` directory as proof of a pre-lane reservation, but a
   * directory alone is not exclusive to `createCampaign` — `FsPoolStore
   * .writePool`'s own `mkdir` (the inline-brief path of
   * `POST /campaigns/pools/copy`) creates the identical shape for ANY id,
   * reserved or not, with no campaign behind it at all. On Postgres this is
   * exactly `campaignMeta(id) !== undefined`: a `pool` row has no foreign key
   * to `campaign` (`0005_pool.sql`), but `campaignMeta` never reads the pool
   * table, so it was never exposed to the same hole.
   */
  hasGenuineReservation(id: string): Promise<boolean>;
}
