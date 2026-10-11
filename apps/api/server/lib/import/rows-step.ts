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
import { hasExpectedHashes } from "./campaign-step.js";
import { importTenant } from "./import-tenant.js";
import { decisionMapProblem } from "./plan.js";
import { getDecisionStore, getPoolStore, getReportStore } from "../ports/index.js";
import type { FollowUpStep } from "./steps.js";

/**
 * What one row write did: stored now, already stored and equal, left alone, or
 * `failed`: the store threw, so whether the row was written is not known.
 */
export type RowStatus = "written" | "skipped" | "refused" | "failed";

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

/** The store calls the row functions make: all a store has to offer them, real or dry. */
export type ReportWriter = Pick<ReportStorePort, "writeReport">;
export type PoolWriter = Pick<PoolStorePort, "readPool" | "writePool">;
export type DecisionWriter = Pick<DecisionStorePort, "writeDecisions">;
export type DecisionReader = Pick<DecisionStorePort, "readDecisions">;

/** The three stores one campaign's rows go through. */
export interface RowStores {
  readonly reports: ReportWriter;
  readonly pools: PoolWriter;
  readonly decisions: DecisionWriter & DecisionReader;
}

/** Where the rows' files are, and the reviewed hash of each (D221). */
export interface RowSource {
  readonly projectRoot: string;
  readonly outputRoot: string;
  readonly expectedHashes: ReadonlyMap<string, string>;
}

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
  reports: ReportWriter,
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

/** One row from its reviewed file: `undefined` when the file is absent, refused when it is not the reviewed one. */
async function fromReviewed(
  kind: RowResult["kind"],
  root: string,
  rel: string,
  expected: ReadonlyMap<string, string>,
  write: (bytes: Buffer) => Promise<RowResult>,
): Promise<RowResult | undefined> {
  const file = await readReviewed(root, rel, expected);
  if (file.state === "absent") return undefined;
  if (file.state === "refused") return { kind, status: "refused", reason: file.reason };
  return write(file.bytes);
}

/**
 * Import one campaign's report from `<outputRoot>/reports/<slug>.json` (PT-8c).
 * `undefined` when the campaign has no report file: that is a normal state and
 * blocks nothing. A file that is not the reviewed one is a refused row.
 */
export async function importReport(
  reports: ReportWriter,
  source: { readonly outputRoot: string; readonly expectedHashes: ReadonlyMap<string, string> },
  slug: string,
): Promise<RowResult | undefined> {
  return fromReviewed(
    "report",
    source.outputRoot,
    `reports/${slug}.json`,
    source.expectedHashes,
    (bytes) => importReportRow(reports, slug, bytes),
  );
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
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: string } {
  const text = bytes.toString("utf8");
  // As for a report: bytes that do not survive the UTF-8 round trip would be
  // parsed, and then stored, as OTHER text. Refuse them instead.
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    return { ok: false, reason: `${rel} is not valid UTF-8` };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, reason: `${rel} is not JSON (${errorMessage(error)})` };
  }
}

/**
 * Store a legacy `pools.json` as the campaign's pool row (PT-8c item 2; owner,
 * 2026-10-11). The store keeps the canonical form, so the revision compared and
 * recorded is the canonical one, and `recanonicalised` says the file's own bytes
 * differ from it. The stored pool is read first, and a stored pool with another
 * revision is refused and untouched. The write is `expectedRevision: null`: it
 * happens only while nothing is stored, in one atomic step in Postgres, so a
 * pool stored between the read and the write is compared, never overwritten.
 */
export async function importPoolRow(
  pools: PoolWriter,
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
  try {
    const written = await pools.writePool(pool, { expectedRevision: null });
    return { kind: "pool", status: "written", revision: written.revision, ...flag };
  } catch (error) {
    // `null` writes only while nothing is stored: a pool stored since the read
    // above is compared like any stored pool, and never overwritten.
    if (!isErrno(error, "ECONFLICT")) throw error;
    const current = (error as { revision?: string }).revision;
    if (current === revision) return { kind: "pool", status: "skipped", revision, ...flag };
    return refused(`a different pool is already stored for ${slug} (revision ${current})`);
  }
}

/** U+0000: JSON allows it in a string (as an escape); Postgres stores it in no text. */
const NUL = String.fromCharCode(0);

/** The first text of one decision that holds U+0000: its key, its actor or its run. */
function nulField(key: string, record: DecisionMap[string]): string | undefined {
  if (key.includes(NUL)) return "key";
  return (["actor", "run"] as const).find((field) => record[field].includes(NUL));
}

/**
 * Store a legacy decisions file as the campaign's decisions (PT-8c item 3; owner,
 * 2026-10-11). The plan's own checks first (the map's shape, the server's time
 * form), then `writeDecisions(slug, map, null)`: it writes only while nothing is
 * stored, in one atomic step. Stored decisions with the same canonical revision
 * are `skipped`, any other are `refused` and untouched. There is no
 * `recanonicalised` flag for decisions; the revision recorded is the stored one.
 */
export async function importDecisionsRow(
  decisions: DecisionWriter,
  slug: string,
  bytes: Buffer,
): Promise<RowResult> {
  const refused = (reason: string): RowResult => ({
    kind: "decisions",
    status: "refused",
    reason,
  });
  const parsed = parseJson(bytes, `decisions/${slug}.json`);
  if (!parsed.ok) return refused(parsed.reason);
  const shape = decisionMapProblem(parsed.value);
  if (shape !== undefined) return refused(shape);
  const map = parsed.value as DecisionMap;
  for (const key of Object.keys(map).sort()) {
    const at = map[key]!.at;
    if (!isDecisionTime(at)) {
      return refused(
        `the decision for ${JSON.stringify(key)} has a time that is not the ISO instant the server stamps: ${JSON.stringify(at)}`,
      );
    }
  }
  // The store sends the map to Postgres as jsonb, which refuses U+0000: refuse it
  // here, in the function `plan` and `apply` both run, so they say the same.
  for (const key of Object.keys(map).sort()) {
    const field = nulField(key, map[key]!);
    if (field !== undefined) {
      return refused(
        `decisions/${slug}.json: the decision for ${JSON.stringify(key)} has the character U+0000 in its ${field}, which the database cannot store`,
      );
    }
  }
  const revision = canonicalRevision(map);
  try {
    await decisions.writeDecisions(slug, map, null);
  } catch (error) {
    if (!(error instanceof DecisionConflictError)) throw error;
    if (error.revision === revision) return { kind: "decisions", status: "skipped", revision };
    return refused(
      `different decisions are already stored for ${slug} (revision ${error.revision})`,
    );
  }
  return { kind: "decisions", status: "written", revision };
}

/** Import one campaign's pool from `<projectRoot>/briefs/<slug>/pools.json`; `undefined` when it has none. */
export async function importPool(
  pools: PoolWriter,
  source: { readonly projectRoot: string; readonly expectedHashes: ReadonlyMap<string, string> },
  slug: string,
): Promise<RowResult | undefined> {
  return fromReviewed(
    "pool",
    source.projectRoot,
    `briefs/${slug}/pools.json`,
    source.expectedHashes,
    (bytes) => importPoolRow(pools, slug, bytes),
  );
}

/** Import one campaign's decisions from `<outputRoot>/decisions/<slug>.json`; `undefined` when it has none. */
export async function importDecisions(
  decisions: DecisionWriter,
  source: { readonly outputRoot: string; readonly expectedHashes: ReadonlyMap<string, string> },
  slug: string,
): Promise<RowResult | undefined> {
  return fromReviewed(
    "decisions",
    source.outputRoot,
    `decisions/${slug}.json`,
    source.expectedHashes,
    (bytes) => importDecisionsRow(decisions, slug, bytes),
  );
}

/**
 * A decisions writer that cannot write: it answers every call with the store's own
 * conflict error carrying the stored revision (`null`: none stored). Run through
 * {@link importDecisions} it yields `skipped` when the stored decisions equal the
 * file's, and `refused` otherwise; no insert, update or delete is ever issued.
 */
function compareOnly(decisions: DecisionReader): DecisionWriter {
  return {
    writeDecisions: async (slug) => {
      throw new DecisionConflictError(slug, (await decisions.readDecisions(slug)).revision);
    },
  };
}

/**
 * The rows of PT-8c, through `stores`: one imported campaign's report, pool and
 * decisions, in that order (owner, 2026-10-11). The pool does not name the
 * report, so it is written whatever the report did. A decision names the run it
 * was given against, so decisions are not written while the report is refused;
 * stored decisions equal to the file's are still `skipped` (a compare-only writer;
 * nothing is written); a campaign with no report file is not blocked. A store that throws is that
 * row `failed`: the rows before it stay recorded and no later row is tried.
 * A refused or failed row makes the campaign's line partial; `applyCampaigns`
 * reads that from the rows.
 */
export async function importRows(
  stores: RowStores,
  ctx: RowSource,
  slug: string,
): Promise<RowResult[]> {
  const rows: RowResult[] = [];
  let kind: RowResult["kind"] = "report";
  try {
    const report = await importReport(stores.reports, ctx, slug);
    if (report !== undefined) rows.push(report);
    kind = "pool";
    const pool = await importPool(stores.pools, ctx, slug);
    if (pool !== undefined) rows.push(pool);
    kind = "decisions";
    if (report?.status === "refused") {
      // Nothing is written while the report is refused. Decisions already stored and
      // equal are still `skipped`: a write would change nothing (owner, 2026-10-11).
      const probe = await importDecisions(compareOnly(stores.decisions), ctx, slug);
      if (probe?.status === "skipped") rows.push(probe);
      else if (probe !== undefined) {
        rows.push({
          kind,
          status: "refused",
          reason: `not written: the report for ${slug} was refused, and a decision names the report it was given against`,
        });
      }
    } else {
      const decisions = await importDecisions(stores.decisions, ctx, slug);
      if (decisions !== undefined) rows.push(decisions);
    }
  } catch (error) {
    rows.push({ kind, status: "failed", reason: errorMessage(error) });
  }
  return rows;
}

/** The follow-up step for PT-8c: {@link importRows} with the target's own stores. */
export const importRowsStep: FollowUpStep = async (ctx, campaign) => {
  if (!hasExpectedHashes(ctx)) throw new Error("no reviewed source hashes in the step context");
  const scope = importTenant(ctx.orgId);
  const stores = {
    reports: getReportStore(scope),
    pools: getPoolStore(scope),
    decisions: getDecisionStore(scope),
  };
  // No `partial` here: `applyCampaigns` makes the line partial from the rows
  // themselves (a refused or failed row), so it cannot be forgotten.
  return { rows: await importRows(stores, ctx, campaign.slug) };
};

/**
 * Stores for `plan`'s read-only probe (owner's decision 8, 2026-10-11). Each
 * answers the ONE call a row function makes the way the real store would, from
 * a read, and writes nothing: a report or decisions write "only while nothing
 * is stored" throws the store's own conflict error when something is. The pool
 * write is insert-only too (`expectedRevision: null`), and `importPoolRow` makes
 * it only after `readPool` found nothing stored: so here it answers the revision
 * the pool would be stored under, without asking again.
 */
export function dryRowStores(
  reports: Pick<ReportStorePort, "getRevision">,
  pools: Pick<PoolStorePort, "readPool">,
  decisions: Pick<DecisionStorePort, "readDecisions">,
): RowStores {
  return {
    reports: {
      writeReport: async (slug) => {
        const current = await reports.getRevision(slug);
        if (current !== undefined) throw new ReportConflictError(slug, current);
        return `reports/${slug}.json`;
      },
    },
    pools: {
      readPool: (slug) => pools.readPool(slug),
      writePool: async (pool) => ({ pool, revision: canonicalRevision(pool) }),
    },
    decisions: {
      readDecisions: (slug) => decisions.readDecisions(slug),
      writeDecisions: async (slug, map) => {
        const current = (await decisions.readDecisions(slug)).revision;
        if (current !== null) throw new DecisionConflictError(slug, current);
        return canonicalRevision(map);
      },
    },
  };
}

/**
 * A row as `plan` shows it: what `apply` WOULD do with it. `failed` is not a
 * prediction: the probe's read threw, so nothing is said about this row or the
 * rows after it.
 */
export interface PlannedRow {
  readonly kind: RowResult["kind"];
  readonly predicted: "write" | "skip" | "refuse" | "failed";
  readonly revision?: string;
  readonly reason?: string;
  readonly recanonicalised?: boolean;
}

const PREDICTED = {
  written: "write",
  skipped: "skip",
  refused: "refuse",
  failed: "failed",
} as const;

/**
 * Predict one campaign's rows for `plan`. It RUNS {@link importRows}, the
 * function `apply` runs, so the prediction cannot drift from the import; give
 * it {@link dryRowStores} and it writes nothing.
 */
export async function predictRows(
  stores: RowStores,
  ctx: RowSource,
  slug: string,
): Promise<PlannedRow[]> {
  return (await importRows(stores, ctx, slug)).map(({ kind, status, ...rest }) => ({
    kind,
    predicted: PREDICTED[status],
    ...rest,
  }));
}
