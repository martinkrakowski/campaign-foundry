import type { Dirent } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { errorMessage } from "@campaignfoundry/shared";
import { isBriefSourceName, isErrno } from "../brief-files.js";
import type { ScanResult } from "./scan.js";
import type { StepContext } from "./steps.js";

/**
 * The D227 census for PT-8a's `plan`: every category the legacy tree holds that
 * this importer does NOT import, listed by name with a count — never silently
 * dropped. The census also owns {@link readBounded}, the one reader every file
 * this lane touches goes through, because the census and the digest are the
 * two callers that read files without a parse rule of their own.
 */

/** The most a single file may be read in full (8 MiB): a legacy tree's outlier never hangs a run. */
export const MAX_IMPORT_JSON_BYTES = 8 * 1024 * 1024;

/** What {@link readBounded} answers: the bytes, or why they were not read. */
export type Bounded =
  | { readonly ok: true; readonly bytes: Buffer }
  | { readonly ok: false; readonly reason: string };

/**
 * The ONE reader for every file this lane touches (req 13, req 19): `lstat`, so
 * a symlink is refused AS a link and never followed (`scan.ts:109`'s wording),
 * a non-file refused, an oversize file refused, and every throw a value — the
 * same capture-don't-crash rule the scan gives a malformed brief.
 */
export async function readBounded(path: string): Promise<Bounded> {
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink()) {
      return { ok: false, reason: `${path} is a symlink; the importer never follows one` };
    }
    if (!st.isFile()) {
      return { ok: false, reason: `${path} is not a regular file.` };
    }
    if (st.size > MAX_IMPORT_JSON_BYTES) {
      return {
        ok: false,
        reason: `${path} is ${st.size} bytes; the import cap is ${MAX_IMPORT_JSON_BYTES} bytes.`,
      };
    }
    return { ok: true, bytes: await readFile(path) };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

/** One census entry: a count, and every reason it is that count instead of another. */
export type CensusCategory = {
  readonly count: number;
  readonly note?: string;
  readonly names?: readonly string[];
  readonly refusal?: string;
  readonly symlinks?: number;
};

export type CensusKey =
  | "jobs"
  | "backgroundCache"
  | "drafts"
  | "lastOpened"
  | "usage"
  | "providerKeys"
  | "templates"
  | "packages"
  | "legacyReportPointer"
  | "orphanRenders"
  | "nonBriefFiles"
  | "refusedBriefs"
  | "samples";

/** The D227 census: thirteen named categories, every one answered. */
export type Census = Record<CensusKey, CensusCategory>;

/**
 * The top-level names under `<output>/` that are NOT campaign slugs (reqs 14
 * and 17): `RESERVED_STORE_AREAS`'s four, the two store directories and the
 * packages route segment this importer must not mistake for slugs, and the
 * retired top-level pointer file.
 */
export const RESERVED_OUTPUT_ROOT_NAMES = [
  "cache",
  "jobs",
  "last-opened",
  "orgs",
  "reports",
  "decisions",
  "packages",
  "report.json",
] as const;

const PG_ONLY = {
  count: 0,
  note: "pg-only or in-memory; nothing on disk to import",
} as const;

/** What the census needs of the scan: the refusals (refusedBriefs) and the sample counts. */
export type CensusScanInput = Pick<ScanResult, "refusals" | "samples">;

/** Count the regular files under `dir`, recursively, refusing a link and never following it. */
async function countFiles(dir: string): Promise<CensusCategory> {
  const tally = { count: 0, symlinks: 0 };
  const categoryRefusals: string[] = [];
  // The ROOT is lstat-checked first: `readdir` follows a symlinked directory,
  // so a `jobs` that is a link to `/etc` would otherwise count `/etc`'s files.
  try {
    const st = await lstat(dir);
    if (st.isSymbolicLink()) return { count: 0, symlinks: 1 };
    if (!st.isDirectory()) return { count: 0, refusal: `${dir} is not a directory.` };
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { count: 0 };
    return { count: 0, refusal: errorMessage(error) };
  }
  const walk = async (current: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      categoryRefusals.push(`${current} could not be read: ${errorMessage(error)}`);
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        tally.symlinks++;
        continue;
      }
      if (entry.isDirectory()) {
        await walk(join(current, entry.name));
        continue;
      }
      tally.count++;
    }
  };
  await walk(dir);
  if (categoryRefusals.length > 0) {
    return {
      count: 0,
      refusal: categoryRefusals[0]!,
      symlinks: tally.symlinks > 0 ? tally.symlinks : undefined,
    };
  }
  return { count: tally.count, symlinks: tally.symlinks > 0 ? tally.symlinks : undefined };
}

/**
 * Whether every directory between `root` and a file's parent is real: `lstat`
 * of each segment from the root down, refusing a symlinked directory with
 * `scan.ts:109`'s rule for a symlinked `briefs/<slug>/`, and a non-directory.
 * `rel` is the file's path relative to `root`; the FINAL segment is the file
 * itself and is not asked here — `readBounded` answers for it.
 */
export async function parentsAreReal(root: string, rel: string): Promise<string | undefined> {
  const parts = rel.split("/");
  try {
    for (let depth = 1; depth < parts.length; depth++) {
      const dir = resolve(root, ...parts.slice(0, depth));
      const st = await lstat(dir);
      if (st.isSymbolicLink()) {
        return `${relative(root, dir)} is a symlinked directory; the importer never follows one`;
      }
      if (!st.isDirectory()) {
        return `${relative(root, dir)} is not a directory.`;
      }
    }
  } catch (error) {
    return errorMessage(error);
  }
  return undefined;
}

/** The one file a category names, answered the same way the walk answers a tree. */ async function countOneFile(
  path: string,
): Promise<CensusCategory> {
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink()) return { count: 0, symlinks: 1 };
    if (!st.isFile()) return { count: 0, refusal: `${path} is not a regular file.` };
    return { count: 1 };
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { count: 0 };
    return { count: 0, refusal: errorMessage(error) };
  }
}

/**
 * The orphan walk (req 14, D223): every regular file under a slug directory
 * that no report field names is counted, never imported — and a slug's own
 * `packages/` directory is counted under `packages` instead (D224).
 */
async function orphanWalk(
  ctx: StepContext,
  namedRenders: ReadonlySet<string>,
): Promise<{ orphans: CensusCategory; packages: CensusCategory }> {
  const orphans = { count: 0, symlinks: 0, refusals: [] as string[] };
  const packages = { count: 0, symlinks: 0, refusals: [] as string[] };
  const walkSlugDir = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      orphans.refusals.push(`${dir} could not be read: ${errorMessage(error)}`);
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        orphans.symlinks++;
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name === "packages") {
          const counted = await countFiles(join(dir, "packages"));
          packages.count += counted.count;
          packages.symlinks += counted.symlinks ?? 0;
          if (counted.refusal !== undefined) {
            packages.refusals.push(counted.refusal);
          }
          continue;
        }
        await walkSlugDir(join(dir, entry.name));
        continue;
      }
      // Not a link, not a directory: a render, or a special file a legacy tree
      // left behind — both counted, and neither ever opened.
      if (!namedRenders.has(join(dir, entry.name))) orphans.count++;
    }
  };
  const walkRoot = async (current: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (!isErrno(error, "ENOENT")) {
        orphans.refusals.push(`${current} could not be read: ${errorMessage(error)}`);
      }
      return;
    }
    for (const entry of entries) {
      if ((RESERVED_OUTPUT_ROOT_NAMES as readonly string[]).includes(entry.name)) continue;
      if (entry.isDirectory()) {
        await walkSlugDir(join(current, entry.name));
        continue;
      }
      if (entry.isSymbolicLink()) orphans.symlinks++;
    }
  };
  await walkRoot(ctx.outputRoot);
  return {
    orphans: {
      count: orphans.count,
      symlinks: orphans.symlinks > 0 ? orphans.symlinks : undefined,
      refusal: orphans.refusals[0],
    },
    packages: {
      count: packages.count,
      symlinks: packages.symlinks > 0 ? packages.symlinks : undefined,
      refusal: packages.refusals[0],
    },
  };
}

/**
 * The D227 census: thirteen named categories, every one answered, nothing
 * silent. `namedRenders` is the set of absolute paths the plan's reports name
 * (plan.ts resolved them) — the only thing that separates an orphan render
 * from one a report row names.
 */
export async function assembleCensus(
  ctx: StepContext,
  scan: CensusScanInput,
  namedRenders: ReadonlySet<string>,
): Promise<Census> {
  const briefsDir = join(ctx.projectRoot, "briefs");
  const { orphans, packages: slugPackages } = await orphanWalk(ctx, namedRenders);
  const packagesRoot = await countFiles(join(ctx.outputRoot, "packages"));
  const lastOpened = await countFiles(join(ctx.projectRoot, "state", "last-opened"));
  const packagesSymlinks = (packagesRoot.symlinks ?? 0) + (slugPackages.symlinks ?? 0);

  // briefs/: the campaign directories' drafts (D227), and the top-level
  // entries that are neither a brief nor a campaign directory. Every
  // campaign's draft area that cannot be counted is carried — joined with
  // "; " into the one `refusal` the category carries, so a slug whose drafts
  // are unreadable is NAMED, never silently counted as zero.
  const drafts = { count: 0, symlinks: 0, refusals: [] as string[] };
  const nonBrief = { count: 0, names: [] as string[], symlinks: 0 };
  let briefsListing: Dirent[] | undefined;
  let briefsRefusal: string | undefined;
  try {
    briefsListing = await readdir(briefsDir, { withFileTypes: true });
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      briefsRefusal = `${briefsDir} could not be read: ${errorMessage(error)}`;
    }
  }
  if (briefsListing !== undefined) {
    for (const entry of briefsListing) {
      if (entry.isDirectory()) {
        const draftFiles = await countFiles(join(briefsDir, entry.name, "drafts"));
        drafts.count += draftFiles.count;
        drafts.symlinks += draftFiles.symlinks ?? 0;
        if (draftFiles.refusal !== undefined) drafts.refusals.push(draftFiles.refusal);
        continue;
      }
      if (entry.isSymbolicLink()) {
        // The link is recorded ONLY by the symlinks count: a link's name is
        // not a file the tree holds, and listing it beside the files it is
        // not would read like one.
        nonBrief.symlinks++;
        continue;
      }
      if (!isBriefSourceName(entry.name)) {
        nonBrief.count++;
        nonBrief.names.push(entry.name);
      }
    }
  }

  const refusedBriefs = scan.refusals.filter(
    (refusal) => refusal.slug === null && isBriefSourceName(basename(refusal.sourcePath)),
  ).length;

  return {
    jobs: await countFiles(join(ctx.outputRoot, "jobs")),
    backgroundCache: await countFiles(join(ctx.outputRoot, "cache")),
    drafts: {
      count: drafts.count,
      symlinks: drafts.symlinks > 0 ? drafts.symlinks : undefined,
      // A briefs/ that cannot be listed and a draft area that cannot be
      // counted never coexist (no listing, no draft walk), so one refusal
      // slot carries whichever happened.
      refusal: drafts.refusals.length > 0 ? drafts.refusals.join("; ") : briefsRefusal,
    },
    lastOpened,
    usage: PG_ONLY,
    providerKeys: PG_ONLY,
    templates: PG_ONLY,
    packages: {
      count: packagesRoot.count + slugPackages.count,
      symlinks: packagesSymlinks > 0 ? packagesSymlinks : undefined,
      refusal: packagesRoot.refusal ?? slugPackages.refusal,
    },
    legacyReportPointer: await countOneFile(join(ctx.outputRoot, "report.json")),
    orphanRenders: orphans,
    nonBriefFiles: {
      count: nonBrief.count,
      names: nonBrief.names.length > 0 ? nonBrief.names.sort() : undefined,
      symlinks: nonBrief.symlinks > 0 ? nonBrief.symlinks : undefined,
      refusal: briefsRefusal,
    },
    refusedBriefs: { count: refusedBriefs },
    samples: {
      count: ctx.includeSamples ? scan.samples.imported : scan.samples.skipped,
    },
  };
}
