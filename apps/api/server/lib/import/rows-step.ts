import { hashBytes } from "../brief-files.js";
import { ReportConflictError, type ReportStorePort } from "../ports/report-store.port.js";

/** What one row write did: stored now, already stored with these bytes, or left alone. */
export type RowStatus = "written" | "skipped" | "refused";

/** One imported row's result (PT-8c). `revision` is the SHA-256 of the SOURCE bytes. */
export interface RowResult {
  readonly kind: "report";
  readonly status: RowStatus;
  readonly revision: string;
  readonly reason?: string;
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
