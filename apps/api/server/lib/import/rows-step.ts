import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { CopyPool } from "@campaignfoundry/CampaignOrchestration";
import { errorMessage } from "@campaignfoundry/shared";
import { hashBytes, isErrno } from "../brief-files.js";
import {
  DecisionConflictError,
  isDecisionTime,
  type DecisionMap,
  type DecisionStorePort,
} from "../ports/decision-store.port.js";
import { copyPoolProblem, type PoolStorePort } from "../ports/pool-store.port.js";
import { ReportConflictError, type ReportStorePort } from "../ports/report-store.port.js";
import { parentsAreReal, readBounded } from "./census.js";
import { decisionMapProblem } from "./plan.js";

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

/**
 * Import one campaign's report from `<outputRoot>/reports/<slug>.json` (PT-8c).
 * `undefined` when the campaign has no report file: that is a normal state and
 * blocks nothing. A file that is not the reviewed one is a refused row.
 */
export async function importReport(
  reports: ReportStorePort,
  source: { readonly outputRoot: string; readonly expectedHashes: ReadonlyMap<string, string> },
  slug: string,
): Promise<RowResult | undefined> {
  const file = await readReviewed(source.outputRoot, `reports/${slug}.json`, source.expectedHashes);
  if (file.state === "absent") return undefined;
  if (file.state === "refused") return { kind: "report", status: "refused", reason: file.reason };
  return importReportRow(reports, slug, file.bytes);
}

/**
 * The revision either store gives a JSON document it keeps canonically: the
 * SHA-256 of `JSON.stringify(value, null, 2)` plus a newline (F6).
 */
function canonicalRevision(value: unknown): string {
  return hashBytes(Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

/** Parse a source file's bytes as JSON, or say why not, naming the file. */
function parseJson(
  bytes: Buffer,
  rel: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string } {
  try {
    return { ok: true, value: JSON.parse(bytes.toString("utf8")) };
  } catch (error) {
    return { ok: false, reason: `${rel} is not JSON (${errorMessage(error)})` };
  }
}

/**
 * Store a legacy `pools.json` as the campaign's pool row (PT-8c item 2; owner,
 * 2026-10-11). The store keeps the canonical form, so the revision compared and
 * recorded is the canonical one, and `recanonicalised` says the file's own bytes
 * differ from it. `writePool` has no "only if absent" form: the stored pool is
 * read first, and a stored pool with another revision is refused and untouched.
 * The read and the write are two statements: `apply` runs against a quiet target
 * (D225), which is what makes that safe.
 */
export async function importPoolRow(
  pools: PoolStorePort,
  slug: string,
  bytes: Buffer,
): Promise<RowResult> {
  const refused = (reason: string): RowResult => ({ kind: "pool", status: "refused", reason });
  const parsed = parseJson(bytes, `briefs/${slug}/pools.json`);
  if (!parsed.ok) return refused(parsed.reason);
  const problem = copyPoolProblem(parsed.value);
  if (problem !== undefined) return refused(problem);
  const pool = parsed.value as CopyPool;
  if (pool.briefId !== slug) {
    return refused(
      `pools.json names briefId ${JSON.stringify(pool.briefId)}, not ${JSON.stringify(slug)}`,
    );
  }
  const revision = canonicalRevision(pool);
  const recanonicalised = revision !== hashBytes(bytes);
  const flag = recanonicalised ? { recanonicalised: true } : {};
  const stored = await pools.readPool(slug);
  if (stored !== undefined) {
    if (stored.revision !== revision) {
      return refused(
        `a different pool is already stored for ${slug} (revision ${stored.revision})`,
      );
    }
    return { kind: "pool", status: "skipped", revision, ...flag };
  }
  const written = await pools.writePool(pool);
  return { kind: "pool", status: "written", revision: written.revision, ...flag };
}
