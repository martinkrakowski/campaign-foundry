import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import type { ParseBriefOptions } from "../load-brief.js";

/**
 * A brief as persisted in storage with its metadata.
 * `file` identifies the stored object/key; `revision` is its SHA-256 content digest.
 */
export interface StoredBrief {
  readonly file: string;
  readonly brief: CampaignBrief;
  readonly revision: string;
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
   * Fails with an EEXIST error if a brief or file with the same id already exists.
   */
  createBrief(brief: CampaignBrief): Promise<StoredBrief>;

  /**
   * Rewrite an existing brief in its own format.
   * If expectedRevision is provided, verifies revision match before writing;
   * otherwise throws an error with code ECONFLICT.
   */
  rewriteBrief(brief: CampaignBrief, options?: { expectedRevision?: string }): Promise<StoredBrief>;

  /**
   * Replace an existing brief or create it if missing (used for ?replace=1).
   */
  replaceBrief(brief: CampaignBrief, options?: { expectedRevision?: string }): Promise<StoredBrief>;

  /**
   * Compute the revision hash of a brief file / key.
   */
  getRevision(fileOrId: string): Promise<string | undefined>;

  /**
   * True if a brief or file exists at the given file name, key, or path.
   */
  exists(fileOrId: string): Promise<boolean>;

  /**
   * Execute a critical section with per-brief concurrency locking.
   */
  withBriefLock<T>(briefId: string, fn: () => Promise<T>): Promise<T>;
}
