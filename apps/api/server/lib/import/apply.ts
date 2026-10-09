import { digestSourceFiles, planDigest, type DigestFile } from "./digest.js";
import { assemblePlan } from "./plan.js";
import type { PlanAssembled } from "./plan.js";
import { scanBriefs } from "./scan.js";
import type { ScanResult } from "./scan.js";
import type { StepContext } from "./steps.js";

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
