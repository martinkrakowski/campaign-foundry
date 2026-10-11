import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@campaignfoundry/shared";
import { hashBytes, isErrno } from "../brief-files.js";
import { ReportConflictError, type ReportStorePort } from "../ports/report-store.port.js";
import { parentsAreReal, readBounded } from "./census.js";

/** What one row write did: stored now, already stored with these bytes, or left alone. */
export type RowStatus = "written" | "skipped" | "refused";

/**
 * One imported row's result (PT-8c). `revision` is the revision the source has
 * in the form the store keeps it: the stored revision when the row was written
 * or skipped. It is absent when the file could not be read or parsed.
 */
export interface RowResult {
  readonly kind: "report" | "pool" | "decisions";
  readonly status: RowStatus;
  readonly revision?: string;
  readonly reason?: string;
  /** Pools only: the stored bytes are the canonical form, not the file's own (F6). */
  readonly recanonicalised?: boolean;
}

/** A source file as the import may use it: not there, the reviewed bytes, or refused. */
export type Reviewed =
  | { readonly state: "absent" }
  | { readonly state: "ok"; readonly bytes: Buffer }
  | { readonly state: "refused"; readonly reason: string };

/**
 * Read `<root>/<rel>` only if it is still the file the plan's digest covered
 * (D221, D225): never through a symlink (the file or a parent directory), never
 * past the size cap, and only when its SHA-256 is the reviewed one. A file that
 * is not there is `absent` unless the digest named it: then it was removed after
 * the review, which is a change. The wordings are `preflight`'s.
 */
export async function readReviewed(
  root: string,
  rel: string,
  expected: ReadonlyMap<string, string>,
): Promise<Reviewed> {
  const path = join(root, rel);
  try {
    await lstat(path);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) return { state: "refused", reason: errorMessage(error) };
    if (!expected.has(rel)) return { state: "absent" };
    return { state: "refused", reason: `${rel} changed since the digest` };
  }
  const parents = await parentsAreReal(root, rel);
  if (parents !== undefined) return { state: "refused", reason: parents };
  const read = await readBounded(path);
  if (!read.ok) return { state: "refused", reason: read.reason };
  const reviewed = expected.get(rel);
  if (reviewed === undefined) {
    return { state: "refused", reason: `${rel} is not in the reviewed digest` };
  }
  if (reviewed !== hashBytes(read.bytes)) {
    return { state: "refused", reason: `${rel} changed since the digest` };
  }
  return { state: "ok", bytes: read.bytes };
}

/**
 * Store a legacy report file as the campaign's report row (PT-8c item 1, D221).
 * The payload is the file's exact bytes, never a re-serialised parse: the store's
 * revision is the SHA-256 of what it is given, so only the exact bytes keep the
 * revision the file had (F6). `null` writes only while nothing is stored; a stored
 * report with the same revision is `skipped`, any other is `refused` and untouched.
 */
export async function importReportRow(
  reports: ReportStorePort,
  slug: string,
  bytes: Buffer,
): Promise<RowResult> {
  const revision = hashBytes(bytes);
  const payload = bytes.toString("utf8");
  // A string is all `writeReport` takes. Bytes that do not survive the UTF-8 round
  // trip would be stored as OTHER bytes, under another revision: refuse instead.
  if (!Buffer.from(payload, "utf8").equals(bytes)) {
    return {
      kind: "report",
      status: "refused",
      revision,
      reason: `reports/${slug}.json is not valid UTF-8, so its exact bytes cannot be stored`,
    };
  }
  // Owner, 2026-10-11: a report is stored verbatim when it is a JSON object, bad
  // render paths included (the grid shows its placeholder, D223). Anything else
  // is refused: `readReport` parses the body, so such a row would look present
  // and fail every later read.
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    return {
      kind: "report",
      status: "refused",
      revision,
      reason: `reports/${slug}.json is not JSON (${errorMessage(error)})`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      kind: "report",
      status: "refused",
      revision,
      reason: `reports/${slug}.json is not a JSON object, so no later read could use it`,
    };
  }
  try {
    await reports.writeReport(slug, payload, null);
  } catch (error) {
    if (!(error instanceof ReportConflictError)) throw error;
    if (error.revision === revision) return { kind: "report", status: "skipped", revision };
    return {
      kind: "report",
      status: "refused",
      revision,
      reason: `a different report is already stored for ${slug} (revision ${error.revision})`,
    };
  }
  return { kind: "report", status: "written", revision };
}
