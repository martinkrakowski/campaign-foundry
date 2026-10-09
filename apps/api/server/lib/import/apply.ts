import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { digestSourceFiles, planDigest, type DigestFile } from "./digest.js";
import { assemblePlan } from "./plan.js";
import type { PlanAssembled } from "./plan.js";
import { scanBriefs } from "./scan.js";
import type { ScanResult } from "./scan.js";
import type { StepContext } from "./steps.js";
import { objectStore, storeBackend } from "../config.js";

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
    return `apply needs STORE_BACKEND=postgres, and STORE_BACKEND is ${storeBackend() ?? "(unset)"}`;
  }
  if (objectStore() !== "s3") {
    return `apply needs OBJECT_STORE=s3, and OBJECT_STORE is ${objectStore() ?? "(unset)"}`;
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
