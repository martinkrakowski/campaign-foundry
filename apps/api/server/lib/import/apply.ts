import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
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
 */
export function checkResultPath(path: string, ctx: StepContext): string | undefined {
  const abs = resolve(path);
  if (isUnderRoot(abs, ctx.projectRoot) || isUnderRoot(abs, ctx.outputRoot)) {
    return `--result ${JSON.stringify(path)} is under the project or output root`;
  }
  return undefined;
}

/**
 * Open the result file exclusively (N4). The `wx` open fails with EEXIST when a
 * file already sits at the path — the run refuses rather than truncating a prior
 * result; later rewrites in this same run use the returned handle, not another open.
 */
export async function openResult(path: string): Promise<FileHandle> {
  return open(path, "wx");
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
      const result = (await step(ctx, campaign)) as CampaignResult;
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
 * then rewrites that same handle after each campaign. The JSON shape is
 * `{ switchedAt, orgId, digest, campaigns }` — every campaign uuid, asset id and
 * object key this run CREATED (D229), plus a campaign that failed half-way (`partial`).
 */
export class ResultWriter {
  readonly #handle: FileHandle;
  readonly #switchedAt: string;
  readonly #orgId: string;
  readonly #digest: string;
  readonly #entries: CampaignEntry[] = [];

  constructor(handle: FileHandle, switchedAt: string, orgId: string, digest: string) {
    this.#handle = handle;
    this.#switchedAt = switchedAt;
    this.#orgId = orgId;
    this.#digest = digest;
  }

  /** Record one campaign's entry and leave it in the buffer awaiting a flush. */
  add(entry: CampaignEntry): void {
    this.#entries.push(entry);
  }

  /** Rewrite the whole result file from the buffer (D229: after each campaign, and at the end). */
  async flush(): Promise<void> {
    const buf = Buffer.from(
      JSON.stringify({
        switchedAt: this.#switchedAt,
        orgId: this.#orgId,
        digest: this.#digest,
        campaigns: this.#entries,
      }) + "\n",
      "utf8",
    );
    await this.#handle.write(buf, 0, buf.length, 0);
    await this.#handle.truncate(buf.length);
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
