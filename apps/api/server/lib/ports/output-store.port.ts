import type { Readable } from "node:stream";

/**
 * Where a run's output is read back from (PT-0a, C2 of the platform plan):
 * rendered creatives and proofs for the browser, and the platform packages the
 * package routes list and zip. Writes stay with the pipeline's own ports
 * (`ExportPort`, `PackageStorePort`); this port only reads, so the routes stop
 * walking the output tree themselves.
 *
 * `GET /output/**` retires when assets move to signed URLs (D170, PT-4); until
 * then it reads through here, so an object-store adapter can serve it too.
 */

/** One stored file, opened for reading. */
export interface StoredFile {
  /** The stored file's own name, whose extension decides the content type. */
  readonly name: string;
  readonly size: number;
  /**
   * The whole file, or the inclusive byte range. The stream releases the file
   * when it ends or is destroyed, including a client abort.
   */
  stream(range?: { readonly start: number; readonly end: number }): Readable;
  /** Release the file without streaming it (a refused range). */
  close(): Promise<void>;
}

/** An output file, or why there is none: an unusable path, or nothing there. */
export type OutputLookup =
  | { readonly found: true; readonly file: StoredFile }
  | { readonly found: false; readonly reason: "invalid" | "missing" };

/** One file of a platform package, named relative to the package folder. */
export interface PackageFileEntry {
  readonly name: string;
  open(): Readable;
}

export interface OutputStorePort {
  /**
   * An output file by its relative path. The run cache and the job records are
   * not output and answer `missing`; so do directories and anything that is not
   * a regular file.
   */
  openOutput(relativePath: string): Promise<OutputLookup>;
  /**
   * Each platform's `manifest.json` under a campaign's packages, in platform-id
   * order. Unreadable or non-object manifests are skipped. Empty when there are
   * none.
   */
  listPackageManifests(campaignId: string): Promise<readonly object[]>;
  /**
   * The files of one platform package, sorted by name, or `undefined` when the
   * package does not exist. Rejects with an ENOENT/ENOTDIR error when packaging
   * rewrites the folder mid-walk; the caller answers that as "retry".
   */
  listPackageFiles(
    campaignId: string,
    platformId: string,
  ): Promise<readonly PackageFileEntry[] | undefined>;
}
