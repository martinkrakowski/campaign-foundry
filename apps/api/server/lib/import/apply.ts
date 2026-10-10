import { open, readFile, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { digestSourceFiles, planDigest, type DigestFile } from "./digest.js";
import { assemblePlan } from "./plan.js";
import type { PlanAssembled } from "./plan.js";
import { scanBriefs } from "./scan.js";
import type { ScanResult } from "./scan.js";
import type { StepContext, CampaignOutcome, ImportStep, PlannedCampaign } from "./steps.js";
import { IMPORT_STEPS } from "./steps.js";
import { objectStore, storeBackend } from "../config.js";
import type { UnreferencedInputs } from "./asset-step.js";
import type { MintedAsset, CampaignResult, HashedContext } from "./campaign-step.js";
import { preflight, probeCampaign } from "./campaign-step.js";
import { importTenant } from "./import-tenant.js";
import { getBriefStore, getAssetStore } from "../ports/index.js";
import { errorMessage } from "@campaignfoundry/shared";
import type { ScannedCampaign } from "./scan.js";
/**
 * What `replan` hands the apply loop and the result builder: the same scan and
 * digest `plan` prints, plus the reviewed-content hashes the per-campaign step
 * checks each ref against (D221). Built from the SAME `digestSourceFiles` result
 * whose digest is compared with `--expect`, so "what is imported is what was
 * reviewed" is a single scan (D222).
 */
export interface ReplanResult {
  readonly result: ScanResult;
  readonly assembled: PlanAssembled;
  readonly digest: string;
  readonly files: readonly DigestFile[];
  readonly expectedHashes: ReadonlyMap<string, string>;
}

/**
 * Re-plan a tree on the apply side, without touching the target: the exact
 * source scan, plan assembly, and digest `plan()` prints, in one call (D225).
 * `plan.ts` is left alone — these statements are copied, not extracted into it.
 */
export async function replan(ctx: StepContext): Promise<ReplanResult> {
  const result = await scanBriefs(ctx);
  const assembled = await assemblePlan(ctx, result);
  const planned = new Set(
    assembled.reports.flatMap((report) =>
      report.fields.flatMap((field) => (field.status === "ok" ? [field.resolved] : [])),
    ),
  );
  const files = await digestSourceFiles(ctx, result, planned);
  const digest = planDigest({
    files,
    orgId: ctx.orgId,
    switchedAt: ctx.switchedAt.toISOString(),
    includeSamples: ctx.includeSamples,
  });
  const expectedHashes = new Map<string, string>();
  for (const file of files) {
    if (file.sha256 !== undefined) expectedHashes.set(file.rel, file.sha256);
  }
  return { result, assembled, digest, files, expectedHashes };
}

/**
 * The two target guards (N2, D225): `apply` writes rows and objects, so the
 * target MUST be the postgres/object-store backend, confirmed before any write.
 * `resolveSource` already probes the org row; this is the explicit backend gate
 * that keeps an `apply` aimed at the file stores from touching anything.
 */
export function applyGuards(): string | undefined {
  if (storeBackend() !== "postgres") {
    return `apply needs STORE_BACKEND=postgres, and STORE_BACKEND is ${storeBackend()}`;
  }
  if (objectStore() !== "s3") {
    return `apply needs OBJECT_STORE=s3, and OBJECT_STORE is ${objectStore()}`;
  }
  return undefined;
}

/**
 * True when `abs` is `root` itself or lives beneath it, so a result file can never
 * land where the digest scans it (N4). The roots are already absolute and resolved
 * by `resolveSource`, so `relative` answers containment with no further normalising.
 */
function isUnderRoot(abs: string, root: string): boolean {
  const rel = relative(root, abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Refuse a result path that lands under the project or output root (N4): the result
 * is written by this run, but it must never be a file the digest covers, so a
 * result under a source root would both be digested and be overwritten by it.
 *
 * The comparison is over REAL paths (N8b2-3): a `--result` whose parent directory
 * is a symbolic link into the project or output tree passes a lexical check but
 * would let the result file masquerade as a brief. The parent is `realpath`-ed
 * (and joined with the base name) against the real roots; a parent that does not
 * exist is refused by name rather than silently accepted.
 */
export async function checkResultPath(path: string, ctx: StepContext): Promise<string | undefined> {
  const abs = resolve(path);
  const parent = dirname(abs);
  let realParent: string;
  try {
    realParent = await realpath(parent);
  } catch {
    return `--result ${JSON.stringify(path)} has no existing parent directory: ${JSON.stringify(parent)}`;
  }
  const realTarget = join(realParent, basename(abs));
  const realProject = await realpath(ctx.projectRoot);
  const realOutput = await realpath(ctx.outputRoot);
  if (isUnderRoot(realTarget, realProject) || isUnderRoot(realTarget, realOutput)) {
    return `--result ${JSON.stringify(path)} is under the project or output root`;
  }
  return undefined;
}

/**
 * Open the result file exclusively (N4). The `wx` open fails with EEXIST when a
 * file already sits at the path — the run refuses rather than truncating a prior
 * result; later rewrites in this same run use the returned handle, not another open.
 * The parent directory entry is fsynced before returning so the new file path
 * survives a crash.
 */
export async function openResult(path: string): Promise<FileHandle> {
  const handle = await open(path, "wx");
  try {
    const dir = await open(dirname(resolve(path)), "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

/**
 * Classify an existing `--result` path so `apply` can refuse with a message that
 * tells the operator whether the file looks like an interrupted run (D229): an
 * empty file, or one whose first line is a `header` and which has no `summary`
 * line. Anything else — a completed run (it has a summary) or foreign content —
 * is simply "already exists". The file is never read past this check, never
 * deleted, never overwritten.
 */
export async function describeResultRefusal(path: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return `--result ${JSON.stringify(path)} already exists`;
  }
  const interrupted =
    `the result file ${JSON.stringify(path)} exists and has no summary ` +
    `line: it is the record of an interrupted run. Keep it, and give this run a new --result path.`;
  if (text.trim().length === 0) return interrupted;

  const lines = text.split("\n").filter((line) => line.length > 0);
  let hasHeader = false;
  let hasSummary = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A parse failure on the LAST line is a torn line left by a crash in
      // the middle of an append: skip it and fall through to the
      // header/summary decision below. A parse failure on any earlier line is
      // foreign content and stays "already exists".
      if (i === lines.length - 1) continue;
      return `--result ${JSON.stringify(path)} already exists`;
    }
    const kind = (parsed as { kind?: unknown })?.kind;
    if (kind === "header") hasHeader = true;
    else if (kind === "summary") hasSummary = true;
  }
  if (hasHeader && !hasSummary) return interrupted;
  return `--result ${JSON.stringify(path)} already exists`;
}

/** One campaign's row in the result file (D229/D221). */
export interface CampaignEntry {
  readonly slug: string;
  readonly outcome: CampaignOutcome;
  readonly reason?: string;
  readonly partial?: boolean;
  readonly minted: { readonly campaignId?: string; readonly assets: readonly MintedAsset[] };
  readonly unreferencedInputs: UnreferencedInputs;
}

/** What {@link applyCampaigns} returns to the caller for its exit code and summary. */
export interface ApplyCounts {
  readonly created: number;
  readonly completed: number;
  readonly unchanged: number;
  readonly refused: number;
  readonly partial: boolean;
}

/** Read the wider {@link CampaignResult} a step returned; a bare `{ outcome }` gets empty minted. */
function toEntry(slug: string, result: CampaignResult): CampaignEntry {
  return {
    slug,
    outcome: result.outcome,
    reason: result.reason,
    partial: result.partial,
    minted: result.minted ?? { assets: [] },
    unreferencedInputs: result.unreferencedInputs ?? { count: 0, names: [] },
  };
}

/**
 * Run each campaign through `steps` in plan order, feeding each a `HashedContext`
 * (the reviewed hashes ride the context, D221), and stop a campaign's chain at
 * the first `refused` (PT-8-3). `onResult` receives each campaign's entry as the
 * result file must record it — after each campaign AND at the end (D229).
 */
export async function applyCampaigns(
  ctx: HashedContext,
  campaigns: readonly PlannedCampaign[],
  steps: readonly ImportStep[] = IMPORT_STEPS,
  onResult: (entry: CampaignEntry) => Promise<void>,
): Promise<ApplyCounts> {
  const tally: Record<CampaignOutcome, number> = {
    created: 0,
    completed: 0,
    unchanged: 0,
    refused: 0,
  };
  let partial = false;
  for (const campaign of campaigns) {
    let entry: CampaignEntry = {
      slug: campaign.slug,
      outcome: "refused",
      minted: { assets: [] },
      unreferencedInputs: { count: 0, names: [] },
    };
    for (const step of steps) {
      let result: CampaignResult;
      try {
        result = (await step(ctx, campaign)) as CampaignResult;
      } catch (error) {
        // A thrown step becomes this campaign's entry, not a run abort (N8b2):
        // refused, the error named, partial (a throw proves nothing kept), empty
        // minted; the loop then continues with the next campaign.
        result = {
          outcome: "refused",
          reason: errorMessage(error),
          partial: true,
          minted: { assets: [] },
          unreferencedInputs: { count: 0, names: [] },
        };
      }
      entry = toEntry(campaign.slug, result);
      if (result.outcome === "refused") break;
    }
    if (entry.partial) partial = true;
    tally[entry.outcome]++;
    await onResult(entry);
  }
  return {
    created: tally.created,
    completed: tally.completed,
    unchanged: tally.unchanged,
    refused: tally.refused,
    partial,
  };
}

/**
 * The result-file writer (N4, D229): opens once with `wx` (see {@link openResult}),
 * then APPENDS to that handle — one JSON object per line, each fsynced before the
 * loop moves on. The file is JSON Lines:
 *   - line 1: `{ "kind": "header", switchedAt, orgId, digest }`
 *   - one `{ "kind": "campaign", ... }` per campaign, written as each finishes
 *   - the LAST line, written only when the loop ends: `{ "kind": "summary", ... }`
 * No seek, no truncate, no rewrite: a file with no summary line is, by definition,
 * the record of an interrupted run. Every line EXCEPT possibly the last is complete
 * and true: a crash mid-append can leave a final line cut short, which a reader
 * must ignore (see {@link describeResultRefusal}).
 */
export class ResultWriter {
  readonly #handle: FileHandle;
  readonly #switchedAt: string;
  readonly #orgId: string;
  readonly #digest: string;

  constructor(handle: FileHandle, switchedAt: string, orgId: string, digest: string) {
    this.#handle = handle;
    this.#switchedAt = switchedAt;
    this.#orgId = orgId;
    this.#digest = digest;
  }

  /** Write the header line (the first line of the result file). */
  async header(): Promise<void> {
    await this.#append({
      kind: "header",
      switchedAt: this.#switchedAt,
      orgId: this.#orgId,
      digest: this.#digest,
    });
  }

  /** Append one campaign line and fsync it before the next campaign starts. */
  async add(entry: CampaignEntry): Promise<void> {
    await this.#append({ kind: "campaign", ...entry });
  }

  /** Write the summary line (the last line, written only when the loop ends). */
  async summary(counts: ApplyCounts): Promise<void> {
    await this.#append({ kind: "summary", ...counts });
  }

  /** Append one JSON object as a line at the end of the file and fsync the handle. */
  async #append(record: Record<string, unknown>): Promise<void> {
    const buf = Buffer.from(JSON.stringify(record) + "\n", "utf8");
    let offset = 0;
    while (offset < buf.length) {
      const written = await this.#handle.write(buf, offset, buf.length - offset);
      const bytesWritten =
        typeof written === "number" ? written : (written as { bytesWritten: number }).bytesWritten;
      if (bytesWritten === 0) throw new Error("short write: no progress");
      offset += bytesWritten;
    }
    await this.#handle.sync();
  }

  async close(): Promise<void> {
    await this.#handle.close();
  }
}

/** One campaign's read-only `plan` probe (D225). */
export type PlanProbe = {
  readonly slug: string;
  readonly state: "absent" | "unchanged" | "refused" | "completable";
  readonly reason?: string;
};

/**
 * The read-only target probe (8b1) for every campaign `plan` reports: preflight
 * with the reviewed hashes first, then `probeCampaign`. A preflight refusal is
 * the probe `refused` with that reason; `versionless` is reported as
 * `completable` (D225). Called only on the postgres+s3 target, so the org row
 * and the brief/asset stores are already the ones `apply` would write.
 */
export async function planProbes(
  ctx: StepContext,
  campaigns: readonly ScannedCampaign[],
  expectedHashes: ReadonlyMap<string, string>,
): Promise<PlanProbe[]> {
  const briefs = getBriefStore(importTenant(ctx.orgId));
  const assets = getAssetStore(importTenant(ctx.orgId));
  const probes: PlanProbe[] = [];
  for (const scanned of campaigns) {
    const pf = await preflight(ctx, scanned, expectedHashes);
    if (!pf.ok) {
      probes.push({ slug: scanned.slug, state: "refused", reason: pf.reason });
      continue;
    }
    let decision: ReturnType<typeof probeCampaign> extends Promise<infer D> ? D : never;
    try {
      decision = await probeCampaign(briefs, assets, ctx, scanned, pf.preflight);
    } catch (error) {
      probes.push({ slug: scanned.slug, state: "refused", reason: errorMessage(error) });
      continue;
    }
    probes.push({
      slug: scanned.slug,
      state: decision.kind === "versionless" ? "completable" : decision.kind,
      reason: decision.kind === "refused" ? decision.reason : undefined,
    });
  }
  return probes;
}
