import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { resolveAssetPath } from "@campaignfoundry/CreativeGeneration";
import { hashBytes } from "../brief-files.js";
import { readBounded } from "./census.js";
import type { ScanResult } from "./scan.js";
import type { StepContext } from "./steps.js";

/**
 * The plan digest (D225): a sha256 over the canonical serialization of the
 * plan's OWN SOURCE inputs — every source file's sha256, the resolved org, the
 * parsed `--switched-at` and the samples flag — so the digest names what the
 * owner reviewed. It is a statement about WHAT the import saw and WHEN it was
 * planned: a byte changed in any source file, or a different instant, is a
 * different digest, and `apply`'s own probes refuse on one that moved.
 */

/** One source file in the digest: where it sits under its root, and its own sha256. */
export type DigestFile = { readonly rel: string; readonly sha256: string };

export type DigestInputs = {
  readonly files: readonly DigestFile[];
  readonly orgId: string;
  readonly switchedAt: string;
  readonly includeSamples: boolean;
};

/** The digest of the canonical serialization: the `rel`-sorted file set plus the three scalars. */
export function planDigest(inputs: DigestInputs): string {
  const canonical = JSON.stringify({
    files: [...inputs.files].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0)),
    orgId: inputs.orgId,
    switchedAt: inputs.switchedAt,
    includeSamples: inputs.includeSamples,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * The plan's source files, hashed as the plan read them: each campaign's brief,
 * its `campaign.json`, `pools.json`, `reports/<slug>.json` and
 * `decisions/<slug>.json` when present, each clean ref's resolved file, and
 * every refusal `sourcePath` that `lstat` says is a regular file. Every read
 * goes through {@link readBounded}, so a link is never followed and an outlier
 * is never read; a file that cannot be read simply does not enter the digest —
 * the refusal naming it does.
 */
export async function digestSourceFiles(
  ctx: StepContext,
  scan: ScanResult,
): Promise<readonly DigestFile[]> {
  const files = new Map<string, string>();
  const add = async (abs: string, root: string): Promise<void> => {
    const read = await readBounded(abs);
    if (read.ok) files.set(relative(root, abs), hashBytes(read.bytes));
  };

  for (const campaign of scan.campaigns) {
    await add(campaign.sourcePath, ctx.projectRoot);
    await add(join(ctx.projectRoot, "briefs", campaign.slug, "campaign.json"), ctx.projectRoot);
    // The parent is lstat-checked first, exactly as `plan.ts` reads the pool:
    // a symlinked `briefs/<slug>/` would take the bytes from wherever the
    // link points.
    try {
      if ((await lstat(join(ctx.projectRoot, "briefs", campaign.slug))).isSymbolicLink()) {
        continue;
      }
    } catch {
      continue;
    }
    await add(join(ctx.projectRoot, "briefs", campaign.slug, "pools.json"), ctx.projectRoot);
    await add(join(ctx.outputRoot, "reports", `${campaign.slug}.json`), ctx.outputRoot);
    await add(join(ctx.outputRoot, "decisions", `${campaign.slug}.json`), ctx.outputRoot);
    for (const ref of campaign.refs) {
      if (ref.kind === "missing" || ref.kind === "unsafe" || ref.kind === "refused-file") continue;
      const abs = resolveAssetPath(ref.ref, ctx.projectRoot);
      /* istanbul ignore if -- a clean ref resolved under assets/ during the scan;
         `resolveAssetPath` is deterministic on the ref, so it cannot be
         undefined here */
      if (abs === undefined) continue;
      await add(abs, ctx.projectRoot);
    }
  }

  for (const refusal of scan.refusals) {
    const path = refusal.sourcePath;
    // `rel relative to its root`: under the output root (the usual project
    // tree nests `output/` inside the project root, so this arm is checked
    // first) the file sits relative to the output root, and relative to the
    // project root otherwise — the same rule the campaign's own adds above use.
    const root = path.startsWith(ctx.outputRoot + sep) ? ctx.outputRoot : ctx.projectRoot;
    try {
      if (!(await lstat(path)).isFile()) continue;
    } catch {
      continue;
    }
    await add(path, root);
  }

  return [...files].map(([rel, sha256]) => ({ rel, sha256 }));
}
