import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { resolveAssetPath } from "@campaignfoundry/CreativeGeneration";
import { hashBytes } from "../brief-files.js";
import { parentsAreReal, readBounded } from "./census.js";
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

/**
 * One source in the digest, keyed by where it sits under its root. Exactly one
 * of `sha256` (a content hash of bytes the plan read through `readBounded`) or
 * `fingerprint` (an `lstat`-only `size:<n>:mtime:<ms>` stamp for a file the
 * digest must NOT read — a render can be a video larger than the 8 MiB cap,
 * and there can be thousands) is set.
 */
export type DigestFile = {
  readonly rel: string;
  readonly sha256?: string;
  readonly fingerprint?: string;
};

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

/** The `lstat`-only stamp a planned render enters the digest with. */
function fingerprint(st: Stats): string {
  return `size:${st.size}:mtime:${Math.trunc(st.mtimeMs)}`;
}

/**
 * The plan's source files, hashed as the plan read them: each campaign's brief,
 * its `campaign.json`, `pools.json`, `reports/<slug>.json` and
 * `decisions/<slug>.json` when present, each clean ref's resolved file, and
 * every refusal `sourcePath` that `lstat` says is a regular file. Every read
 * goes through {@link readBounded}, so a link is never followed and an outlier
 * is never read; a file that cannot be read simply does not enter the digest —
 * the refusal naming it does.
 *
 * `plannedRenders` is the set of absolute paths `assemblePlan` marked ok: the
 * renders the import would write. They enter the digest as FINGERPRINTS, never
 * as content hashes — the digest must not read a render, only notice that it
 * changed.
 */
export async function digestSourceFiles(
  ctx: StepContext,
  scan: ScanResult,
  plannedRenders: ReadonlySet<string>,
): Promise<readonly DigestFile[]> {
  const files = new Map<string, DigestFile>();
  const add = async (abs: string, root: string): Promise<void> => {
    // The parent directories are asked first (`parentsAreReal`): lstat follows
    // every parent symlink, so a symlinked `briefs/<slug>/` would otherwise
    // hash bytes from outside the roots.
    const parents = await parentsAreReal(root, relative(root, abs));
    if (parents !== undefined) return;
    const read = await readBounded(abs);
    if (read.ok)
      files.set(relative(root, abs), { rel: relative(root, abs), sha256: hashBytes(read.bytes) });
  };
  const fingerprintFile = async (abs: string, root: string): Promise<void> => {
    let st: Stats;
    try {
      st = await lstat(abs);
    } catch {
      // Absent, or a parent lstat could not (EACCES): nothing to fingerprint,
      // and never a throw out of the digest.
      return;
    }
    if (st.isSymbolicLink() || !st.isFile()) return;
    // The same parent rule every read obeys: a file reached through a
    // symlinked directory is not the file the tree holds.
    const parents = await parentsAreReal(root, relative(root, abs));
    if (parents !== undefined) return;
    files.set(relative(root, abs), {
      rel: relative(root, abs),
      fingerprint: fingerprint(st),
    });
  };

  for (const campaign of scan.campaigns) {
    await add(campaign.sourcePath, ctx.projectRoot);
    // The sidecars are read only after their parent checks, never before: a
    // missing or symlinked `briefs/<slug>/` skips BOTH, while the report, the
    // decisions file and the clean refs are added regardless — a campaign
    // without a sidecar directory still has a plan whose sources must be
    // covered.
    await add(join(ctx.projectRoot, "briefs", campaign.slug, "campaign.json"), ctx.projectRoot);
    await add(join(ctx.projectRoot, "briefs", campaign.slug, "pools.json"), ctx.projectRoot);
    await add(join(ctx.outputRoot, "reports", `${campaign.slug}.json`), ctx.outputRoot);
    await add(join(ctx.outputRoot, "decisions", `${campaign.slug}.json`), ctx.outputRoot);
    for (const ref of campaign.refs) {
      if (ref.kind === "missing" || ref.kind === "unsafe") continue;
      const abs = resolveAssetPath(ref.ref, ctx.projectRoot);
      /* istanbul ignore if -- a ref classified under assets/ resolved there during
         the scan; `resolveAssetPath` is deterministic on the ref, so it cannot
         be undefined here */
      if (abs === undefined) continue;
      // A refused-file asset still names a file on disk: it enters the digest
      // as a fingerprint too, so an operator's post-plan edit to it is a
      // different digest, without the digest ever reading its bytes.
      if (ref.kind === "refused-file") await fingerprintFile(abs, ctx.projectRoot);
      else await add(abs, ctx.projectRoot);
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

  for (const abs of plannedRenders) await fingerprintFile(abs, ctx.outputRoot);

  return [...files.values()];
}
