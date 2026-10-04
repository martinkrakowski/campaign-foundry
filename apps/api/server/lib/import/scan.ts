import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { isReservedCampaignId, type CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { errorMessage } from "@campaignfoundry/shared";
import { isBriefSourceName, isErrno } from "../brief-files.js";
import { parseBriefText } from "../load-brief.js";
import { blocksImport, classifyRefs, type RefClassification } from "./classify.js";
import type { PlannedCampaign, StepContext } from "./steps.js";

/**
 * Brief discovery for PT-8a: what the legacy `briefs/` tree holds, and which of it can be
 * imported (D218, D219, D222, Q2's sample rule).
 *
 * **A parse failure is a REFUSAL OF ONE FILE, never a thrown error** (F8): one operator's
 * retired `html` layer must not cost the reviewer the plan for every other campaign, and
 * "never silent" means the file is named with the parser's own message rather than skipped.
 * The whole of this module is therefore read-only — it opens files, asks the filesystem
 * what is there, and returns what it found.
 */

/** One refusal, as the plan reports it: which campaign, which file, and why. */
export type ScanRefusal = {
  /** `null` when the file never parsed and so never named a campaign. */
  readonly slug: string | null;
  readonly sourcePath: string;
  readonly reason: string;
};

/**
 * One discovered campaign, as far as a read-only scan can say anything about it.
 *
 * **`name`/`type` are `null` when there is no `campaign.json`, not "unknown"** (req 7):
 * the importer passes them to `createCampaign` exactly as it found them, so an absent
 * meta file has to be indistinguishable from one that never carried a name.
 */
export type ScannedCampaign = PlannedCampaign & {
  readonly name: string | null;
  readonly type: string | null;
  /** The parsed brief — the only thing {@link classifyRefs} ever reads. */
  readonly brief: CampaignBrief;
  readonly refs: readonly RefClassification[];
  /** Whether this campaign came from a `briefs/sample-*` file (Q2). */
  readonly sample: boolean;
};

/** What one `plan` run found. Nothing here is written anywhere. */
export type ScanResult = {
  readonly campaigns: readonly ScannedCampaign[];
  readonly refusals: readonly ScanRefusal[];
  readonly samples: { readonly skipped: number; readonly imported: number };
};

/** A file that parsed, before the checks that may still refuse it. */
type Parsed = { readonly file: string; readonly path: string; readonly brief: CampaignBrief };

/** `campaign.json`'s name/type. */
type CampaignMeta = { readonly name: string | null; readonly type: string | null };

/**
 * Whether the campaign has a meta file at all, and what it said.
 *
 * **Three states, because presence and readability are two facts** (fix round 1, FIX 5):
 * the versionless-reservation rule turns on the first, the campaign's own name on the
 * second, and a file that is present but unreadable is a REFUSAL of that campaign rather
 * than a silent `null`.
 */
type MetaLookup =
  | { readonly present: false }
  | { readonly present: true; readonly meta: CampaignMeta }
  | { readonly present: true; readonly error: string };

/** Q2: `briefs/sample-*` is a demo, skipped unless `--include-samples` says otherwise. */
function isSample(name: string): boolean {
  return name.startsWith("sample-");
}

/** One refusal appended to the list a file earns, in the order the file was read. */
function refuse(refusals: ScanRefusal[], slug: string | null, path: string, reason: string): void {
  refusals.push({ slug, sourcePath: path, reason });
}

/**
 * D218's reserved-slug rule, and **only** that rule.
 *
 * The `SAFE_ID_PATTERN` half of D218 is NOT re-checked here, because it cannot be:
 * `parseBrief` calls `assertSafeId(record.id, "Campaign id")` (`load-brief.ts:1216`) with
 * that exact pattern, so a brief declaring an unsafe id never reaches this function — it
 * arrives one step earlier as a per-file parse refusal carrying the parser's own wording
 * (`Campaign id must be a path-safe slug…`). A second copy would be unreachable code, and
 * `scan.test.ts` pins the refusal where it actually happens. Nothing renames (F2): a rename
 * would rewrite every report path and drop the report revision, so this is a refusal.
 */
function slugProblem(slug: string): string | undefined {
  return isReservedCampaignId(slug)
    ? `${JSON.stringify(slug)} is a reserved campaign id.`
    : undefined;
}

/** `briefs/<slug>/campaign.json`'s meta, and whether the file was there at all. */
async function readMeta(briefsDir: string, slug: string): Promise<MetaLookup> {
  try {
    const raw = await readFile(join(briefsDir, slug, "campaign.json"), "utf8");
    const parsed = JSON.parse(raw) as { name?: unknown; type?: unknown };
    return {
      present: true,
      meta: {
        name: typeof parsed.name === "string" ? parsed.name : null,
        type: typeof parsed.type === "string" ? parsed.type : null,
      },
    };
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { present: false };
    // Present and unreadable (fix round 1, FIX 5). The earlier shape of this branch
    // degraded to `null`/`null` because that is what `FsBriefStore.campaignMeta` does when
    // a version exists — but the importer is NOT that store's caller, it is a plan the
    // operator reads before anything is written. A null name there became
    // `createCampaign(slug, { name: null })` in PT-8b, and nothing in the plan said a
    // `campaign.json` had ever existed. D227: never silent. The campaign is refused with
    // the read error; the RESERVATION loop below still treats the file as present, because
    // "a `campaign.json` is there and we cannot read it" is not "no campaign was reserved".
    return { present: true, error: errorMessage(error) };
  }
}

/**
 * One entry of `briefs/`, split by what a read-only scan can do with it.
 *
 * **A `briefs/` that cannot be listed is a REFUSAL, never a throw** — the same
 * capture-don't-crash rule F8 gives a malformed file, applied to the directory that holds
 * them. `FsBriefStore.listBriefs` throws here and its route maps that to a 500; an importer
 * has no route, and a run that stopped would cost the reviewer the plan for every other
 * campaign over one unreadable directory. The row's exit taxonomy agrees: `plan` exits
 * non-zero only for a source it cannot read at all, and both roots were already checked
 * by `resolveSource` before this ran.
 */
async function listBriefsDir(projectRoot: string): Promise<{
  files: readonly string[];
  dirs: readonly string[];
  refusal: { readonly sourcePath: string; readonly reason: string } | undefined;
}> {
  const path = join(projectRoot, "briefs");
  let entries: Dirent[];
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    return {
      files: [],
      dirs: [],
      refusal: {
        sourcePath: path,
        reason: isErrno(error, "ENOENT")
          ? "there is no briefs/ directory to import from."
          : `briefs/ could not be read: ${errorMessage(error)}`,
      },
    };
  }
  return {
    files: entries
      .filter((entry) => entry.isFile() && isBriefSourceName(entry.name))
      .map((entry) => entry.name)
      .sort(),
    dirs: entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(),
    refusal: undefined,
  };
}

/**
 * Every campaign the tree holds, and every refusal, in one pass over `briefs/*.{yaml,yml,json}`.
 *
 * **Parsing is `parseBriefText` — the parser `FsBriefStore` uses** — so the importer and
 * the store cannot disagree about what a brief is; only the outcome differs (a recorded
 * refusal here, a warning there). Two passes, not one: a duplicate slug is only knowable
 * once every file has named its id, and a scan that emitted the first of two same-id
 * files as importable would be reporting a decision it had not finished making.
 */
export async function scanBriefs(ctx: StepContext): Promise<ScanResult> {
  const briefsDir = join(ctx.projectRoot, "briefs");
  const { files, dirs, refusal } = await listBriefsDir(ctx.projectRoot);
  const refusals: ScanRefusal[] = [];
  if (refusal !== undefined) refuse(refusals, null, refusal.sourcePath, refusal.reason);

  // Q2: the flag decides, never the file's contents (F7), so an operator-edited sample is
  // still skipped by default. Counted before anything is parsed, and by NAME, so a skipped
  // sample's sidecar can never be mistaken for something the sample rule did not take.
  //
  // **A sidecar directory is COUNTED only when no sample file claims that stem** (fix round
  // 1, FIX 4). `briefs/sample-pooled.yaml` plus `briefs/sample-pooled/` is one sample, and
  // the count's only job is to tell the operator how many samples were skipped: counting
  // both inflated it to two, for one demo brief. An orphan `sample-*` directory with no
  // brief file beside it is still counted — something under `briefs/` really was skipped,
  // and PT-8a2's census is where it gets named.
  //
  // `skippedSampleDirs` stays the FULL list, because the reservation loop below is not about
  // counting: it skips every sample-named directory so a skipped demo can never also be
  // reported as a versionless reservation. Narrowing that list would be a behaviour change
  // FIX 4 did not ask for.
  const sampleFiles = ctx.includeSamples ? [] : files.filter(isSample);
  const skippedSampleDirs = ctx.includeSamples ? [] : dirs.filter(isSample);
  const skipped =
    sampleFiles.length +
    skippedSampleDirs.filter((dir) => !sampleFiles.includes(`${dir}.yaml`)).length;

  const parsed: Parsed[] = [];
  const unparsed = new Set<string>();
  for (const file of files) {
    const path = join(briefsDir, file);
    if (!ctx.includeSamples && isSample(file)) continue;
    try {
      const bytes = await readFile(path);
      const brief = parseBriefText(path, bytes.toString("utf8"));
      // Fix round 1, FIX 2a: `parseBrief` KEEPS unknown top-level keys, so a YAML
      // self-referencing alias survives as a circular object — and the plan is serialised
      // with `JSON.stringify`, which throws on one. Proving serialisability HERE, inside
      // the try that already captures this file's failures, is what turns a run-ending
      // TypeError in `plan` into a refusal of the one brief that caused it.
      JSON.stringify(brief);
      parsed.push({ file, path, brief });
    } catch (error) {
      // The STEM, and only the stem: this file exists, so the reservation loop below must
      // not report its directory as a campaign with no brief (fix round 1, FIX 3).
      unparsed.add(basename(file, extname(file)));
      refuse(refusals, null, path, errorMessage(error));
    }
  }

  // One map per slug, so two files claiming one id both name both files.
  const bySlug = new Map<string, Parsed[]>();
  for (const entry of parsed) {
    bySlug.set(entry.brief.id, [...(bySlug.get(entry.brief.id) ?? []), entry]);
  }

  const campaigns: ScannedCampaign[] = [];
  for (const entry of parsed) {
    const { file, path, brief } = entry;
    // Every parsed entry is a key of `bySlug` — that map was built from exactly this list
    // — so the lookup can only be absent if the map was wrong, which it is not.
    const claimed = bySlug.get(brief.id)!;
    if (claimed.length > 1) {
      refuse(
        refusals,
        brief.id,
        path,
        `${JSON.stringify(brief.id)} is declared by ${claimed.length} source files: ` +
          `${claimed.map((each) => JSON.stringify(each.file)).join(", ")}.`,
      );
      continue;
    }
    const problem = slugProblem(brief.id);
    if (problem !== undefined) {
      refuse(refusals, brief.id, path, problem);
      continue;
    }
    const meta = await readMeta(briefsDir, brief.id);
    // FIX 5: a `campaign.json` that is there and unreadable refuses the campaign, with the
    // read error named — rather than importing it with `name: null` and saying nothing.
    if ("error" in meta) {
      refuse(refusals, brief.id, path, `campaign.json could not be read: ${meta.error}`);
      continue;
    }
    // The draft carries no refs because {@link classifyRefs} takes the campaign it
    // classifies: the campaign is the thing that knows its slug and its brief, and a
    // classifier handed two loose arguments would be one step from disagreeing with it.
    const draft: ScannedCampaign = {
      slug: brief.id,
      sourcePath: path,
      name: meta.present ? meta.meta.name : null,
      type: meta.present ? meta.meta.type : null,
      brief,
      refs: [],
      sample: isSample(file),
    };
    const refs = classifyRefs(ctx, draft);
    const campaign: ScannedCampaign = { ...draft, refs };
    // D222: a campaign with a ref the import cannot satisfy is refused WHOLE, with the
    // ref named — never imported with the path left in place, which would render ENOENT
    // under s3 and keep D214(c)'s dirty-after-Save defect alive.
    const blocking = refs.find(blocksImport);
    if (blocking !== undefined) {
      refuse(refusals, brief.id, path, `ref ${JSON.stringify(blocking.ref)}: ${blocking.reason}`);
      continue;
    }
    campaigns.push(campaign);
  }

  // A `briefs/<slug>/` directory holding a `campaign.json` and no brief file is a
  // RESERVATION (PT-5b3's shape), not a parse failure: the campaign was named before any
  // version was saved, and the importer must list it rather than invent a brief for it.
  for (const dir of dirs) {
    if (skippedSampleDirs.includes(dir)) continue;
    if (bySlug.has(dir)) continue;
    // FIX 3: a file that FAILED to parse is still a brief file for its stem. Its id was
    // never read — which is exactly why the importer cannot claim the campaign has no brief
    // — so without this the same tree produced a second refusal asserting something false.
    // Only UNPARSED stems are collected, never every stem: `legacy.yaml` failing to parse
    // says nothing about `legacy-2.yaml`.
    if (unparsed.has(dir)) continue;
    const meta = await readMeta(briefsDir, dir);
    if (!meta.present) continue;
    refuse(
      refusals,
      dir,
      join(briefsDir, dir, "campaign.json"),
      "a versionless reservation: briefs/<slug>/campaign.json with no brief file for that slug.",
    );
  }

  return {
    campaigns,
    refusals,
    samples: { skipped, imported: campaigns.filter((campaign) => campaign.sample).length },
  };
}
