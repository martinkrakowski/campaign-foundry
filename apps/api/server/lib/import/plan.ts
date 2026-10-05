import { lstatSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { contentTypeFor } from "@campaignfoundry/Distribution";
import { errorMessage } from "@campaignfoundry/shared";
import { isErrno } from "../brief-files.js";
import { resolveConfined } from "../confined-path.js";
import { copyPoolProblem } from "../ports/pool-store.port.js";
import { parentsAreReal, readBounded } from "./census.js";
import type { ScanRefusal, ScanResult, ScannedCampaign } from "./scan.js";
import type { StepContext } from "./steps.js";

/**
 * The plan's report/pool/decision sections (row items 6 and 7): for every
 * campaign the scan found importable, what its legacy report, copy pool and
 * decision record hold, and which of it the import could actually use.
 *
 * **A problem APPENDS to the run's refusal list with the slug set and never
 * removes the campaign** (D223: the report is still imported): these are facts
 * about one file each, and the reviewer reads them beside the plan, not
 * instead of it. Nothing here is written anywhere.
 */

/** The five report fields signed-urls resolves to URLs (`signed-urls.ts:126-146`). */
const REPORT_FIELDS = [
  "outputPath",
  "videoPath",
  "htmlFallbackPath",
  "proofPath",
  "htmlBundlePath",
] as const;

/** The five report fields, as a type, so a refusal can name its field structurally. */
export type ReportPathField = (typeof REPORT_FIELDS)[number];

/**
 * A refusal as the plan carries it: a scan refusal, plus the structured field
 * a report-field refusal came from. The reason stays BARE — the field is a
 * property of the refusal, not decoration on its message, so a consumer sorts
 * by field without parsing strings.
 */
export type PlanRefusal = ScanRefusal & { readonly field?: ReportPathField };

/**
 * One report field's verdict. `resolved` is the LEXICAL resolution under the
 * output root — set whenever `resolveConfined` accepted the value, refused or
 * not, because a field a report row names separates a named render from an
 * orphan one (D223) even when the field itself was refused; `null` only when
 * the value escapes the root and names nothing this import could touch.
 */
export type ReportFieldPlan =
  | {
      readonly field: string;
      readonly path: string;
      readonly status: "ok";
      readonly resolved: string;
    }
  | {
      readonly field: string;
      readonly path: string;
      readonly status: "refused";
      readonly resolved: string | null;
      readonly reason: string;
    };

/** One campaign's legacy report, as the plan reports it. */
export type ReportPlan = {
  readonly slug: string;
  readonly present: boolean;
  readonly fields: readonly ReportFieldPlan[];
  readonly problems: readonly string[];
};

/**
 * One campaign's copy pool. A valid pool passes THROUGH to the plan (req 15):
 * `pool` is the parsed `CopyPool` the campaign was found with, so the reviewer
 * reads what `apply` would copy, not just that something is there.
 */
export type PoolPlan = {
  readonly slug: string;
  readonly present: boolean;
  readonly problems: readonly string[];
  readonly pool?: unknown;
};

/** One campaign's decision record. */
export type DecisionPlan = {
  readonly slug: string;
  readonly present: boolean;
  readonly problems: readonly string[];
};

/** What {@link assemblePlan} adds to a scan. */
export type PlanAssembled = {
  readonly reports: readonly ReportPlan[];
  readonly pools: readonly PoolPlan[];
  readonly decisions: readonly DecisionPlan[];
  readonly refusals: readonly PlanRefusal[];
};

/** A file read if it is there: present (with bytes or the reason it was not read) or absent. */
type PresentFile =
  | { readonly present: false }
  | { readonly present: true; readonly bytes?: Buffer; readonly refusal?: string };

/**
 * Presence and read in one step, through {@link readBounded}: absent is a
 * normal state (no refusal), while a file that is there and cannot be read is
 * a refusal of that file — never a throw and never a silent skip. The parent
 * directories are asked first (`parentsAreReal`): `lstat` follows every parent
 * symlink, so a symlinked `<output>/reports/` or `briefs/<slug>/` would
 * otherwise supply bytes from outside the roots.
 */
async function readIfPresent(root: string, path: string, display: string): Promise<PresentFile> {
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink()) {
      return {
        present: true,
        refusal: `${display} is a symlink; the importer never follows one`,
      };
    }
    if (!st.isFile()) {
      return { present: true, refusal: `${display} is not a regular file.` };
    }
    const parents = await parentsAreReal(root, relative(root, path));
    if (parents !== undefined) return { present: true, refusal: parents };
    const read = await readBounded(path);
    if (!read.ok) return { present: true, refusal: read.reason };
    return { present: true, bytes: read.bytes };
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { present: false };
    return { present: true, refusal: errorMessage(error) };
  }
}

/**
 * One report field's verdict, refusing per FIELD (req 13): a lexical
 * `resolveConfined` (the value is file content, so it is never trusted),
 * `lstat` of every directory between `<output>/` and the file exactly as
 * `classify.ts:143-154`, then `lstat` of the file itself, then the extension
 * `contentTypeFor` accepts. `lstatSync`, never `stat`/`realpath`/`existsSync`
 * — a symlink is refused AS a link and never followed.
 */
function planReportField(
  ctx: StepContext,
  refusals: PlanRefusal[],
  slug: string,
  reportPath: string,
  field: ReportPathField,
  path: string,
): ReportFieldPlan {
  const refuse = (resolved: string | null, reason: string): ReportFieldPlan => {
    refusals.push({ slug, sourcePath: reportPath, reason, field });
    return { field, path, status: "refused", resolved, reason };
  };
  let resolved: string;
  try {
    resolved = resolveConfined(ctx.outputRoot, path);
  } catch (error) {
    return refuse(null, errorMessage(error));
  }
  // A report names only its OWN campaign's renders — the rule `renderObjectKey`
  // enforces by keeping the brief id as the leading path segment it is checked
  // and then dropped against: a `camp-a` report pointing into `camp-b`'s area
  // would plan bytes the exporter would refuse to write for this campaign.
  const first = relative(ctx.outputRoot, resolved).split("/", 1)[0]!;
  if (first !== slug) {
    return refuse(
      resolved,
      `${JSON.stringify(path)} names ${JSON.stringify(first)}'s render area, not ${JSON.stringify(slug)}'s.`,
    );
  }
  // ONE try from the file's lstat to the extension check, exactly as
  // `classify.ts` reads a ref: every filesystem error is this field's refusal,
  // never a throw into the run.
  try {
    const st = lstatSync(resolved, { throwIfNoEntry: false });
    if (st === undefined) {
      return refuse(resolved, `no file at ${JSON.stringify(path)}`);
    }
    const rel = relative(ctx.outputRoot, resolved);
    const parts = rel.split("/");
    for (let depth = 1; depth < parts.length; depth++) {
      const dir = parts.slice(0, depth);
      if (lstatSync(resolve(ctx.outputRoot, ...dir)).isSymbolicLink()) {
        return refuse(
          resolved,
          `${JSON.stringify(dir.join("/"))} is a symlinked directory; the importer never follows one`,
        );
      }
    }
    if (st.isSymbolicLink()) {
      return refuse(
        resolved,
        `${JSON.stringify(path)} is a symlink; the importer never follows one`,
      );
    }
    if (!st.isFile()) {
      return refuse(resolved, `${JSON.stringify(path)} is not a regular file.`);
    }
    try {
      contentTypeFor(path);
    } catch (error) {
      return refuse(resolved, errorMessage(error));
    }
    return { field, path, status: "ok", resolved };
  } catch (error) {
    return refuse(resolved, errorMessage(error));
  }
}

/** One campaign's report section, reading `<output>/reports/<slug>.json` when it is there. */
async function reportPlan(
  ctx: StepContext,
  refusals: PlanRefusal[],
  campaign: ScannedCampaign,
): Promise<ReportPlan> {
  const slug = campaign.slug;
  const reportPath = join(ctx.outputRoot, "reports", `${slug}.json`);
  const append = (reason: string): void => {
    refusals.push({ slug, sourcePath: reportPath, reason });
  };
  const read = await readIfPresent(ctx.outputRoot, reportPath, `reports/${slug}.json`);
  if (!read.present) return { slug, present: false, fields: [], problems: [] };
  if (read.refusal !== undefined) {
    append(read.refusal);
    return { slug, present: true, fields: [], problems: [read.refusal] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.bytes!.toString("utf8"));
  } catch (error) {
    const reason = errorMessage(error);
    append(reason);
    return { slug, present: true, fields: [], problems: [reason] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    const reason = "the report is not an object.";
    append(reason);
    return { slug, present: true, fields: [], problems: [reason] };
  }
  const record = parsed as Record<string, unknown>;
  const fields: ReportFieldPlan[] = [];
  for (const field of REPORT_FIELDS) {
    const path = record[field];
    if (typeof path !== "string" || path === "") continue;
    fields.push(planReportField(ctx, refusals, slug, reportPath, field, path));
  }
  return { slug, present: true, fields, problems: [] };
}

/** One campaign's pool section, reading `briefs/<slug>/pools.json` when it is there. */
async function poolPlan(
  ctx: StepContext,
  refusals: PlanRefusal[],
  campaign: ScannedCampaign,
): Promise<PoolPlan> {
  const slug = campaign.slug;
  const parent = join(ctx.projectRoot, "briefs", slug);
  const poolsPath = join(parent, "pools.json");
  const append = (reason: string): void => {
    refusals.push({ slug, sourcePath: poolsPath, reason });
  };
  // The parent is lstat-checked first, exactly as `scan.ts:106` does for
  // `campaign.json`: a symlinked `briefs/<slug>/` would take the pool from
  // wherever the link points.
  try {
    if ((await lstat(parent)).isSymbolicLink()) {
      const reason = `briefs/${slug} is a symlink; the importer never follows one`;
      append(reason);
      return { slug, present: false, problems: [reason] };
    }
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      const reason = errorMessage(error);
      append(reason);
      return { slug, present: false, problems: [reason] };
    }
    return { slug, present: false, problems: [] };
  }
  const read = await readIfPresent(ctx.projectRoot, poolsPath, `briefs/${slug}/pools.json`);
  if (!read.present) return { slug, present: false, problems: [] };
  if (read.refusal !== undefined) {
    append(read.refusal);
    return { slug, present: true, problems: [read.refusal] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.bytes!.toString("utf8"));
  } catch (error) {
    const reason = errorMessage(error);
    append(reason);
    return { slug, present: true, problems: [reason] };
  }
  const problem = copyPoolProblem(parsed);
  if (problem !== undefined) {
    append(problem);
    return { slug, present: true, problems: [problem] };
  }
  const pool = parsed as { briefId: unknown };
  // The keyed pool reads' own rule (`fs-pool-store.ts`'s readPool): the file
  // under `briefs/<slug>/pools.json` names ITS campaign, or it is not this
  // campaign's pool and must not pass as one.
  if (pool.briefId !== slug) {
    const reason = `pools.json names briefId ${JSON.stringify(pool.briefId)}, not ${JSON.stringify(slug)}`;
    append(reason);
    return { slug, present: true, problems: [reason] };
  }
  return { slug, present: true, problems: [], pool: parsed };
}

/**
 * Whether a parsed record is a decision map, restating `fs-decision-store.ts`'s
 * private `isDecisionMap` — an object, not an array; every value has `verdict`
 * `approved`|`rejected` and string `actor`/`at`/`run`. The shape check is local
 * because that file is not importable from here, and the disagreement it would
 * risk is the same one a second copy always risks.
 */
function decisionMapProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "the decisions must be an object keyed by review key.";
  }
  const record = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const at = `the decision for ${JSON.stringify(key)}`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return `${at} must be an object.`;
    }
    const one = entry as { verdict?: unknown; actor?: unknown; at?: unknown; run?: unknown };
    if (one.verdict !== "approved" && one.verdict !== "rejected") {
      return `${at} has no "approved"/"rejected" verdict.`;
    }
    if (typeof one.actor !== "string") return `${at} has no actor.`;
    if (typeof one.at !== "string") return `${at} has no time.`;
    if (typeof one.run !== "string") return `${at} has no run.`;
  }
  return undefined;
}

/** Restating `decision-store.port.ts`'s `isDecisionTime`: the server's UTC ISO instant, exactly. */
function isDecisionTime(at: string): boolean {
  const time = Date.parse(at);
  return !Number.isNaN(time) && new Date(time).toISOString() === at;
}

/** One campaign's decision section, reading `<output>/decisions/<slug>.json` when it is there. */
async function decisionPlan(
  ctx: StepContext,
  refusals: PlanRefusal[],
  campaign: ScannedCampaign,
): Promise<DecisionPlan> {
  const slug = campaign.slug;
  const decisionsPath = join(ctx.outputRoot, "decisions", `${slug}.json`);
  const append = (reason: string): void => {
    refusals.push({ slug, sourcePath: decisionsPath, reason });
  };
  const read = await readIfPresent(ctx.outputRoot, decisionsPath, `decisions/${slug}.json`);
  if (!read.present) return { slug, present: false, problems: [] };
  if (read.refusal !== undefined) {
    append(read.refusal);
    return { slug, present: true, problems: [read.refusal] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.bytes!.toString("utf8"));
  } catch (error) {
    const reason = errorMessage(error);
    append(reason);
    return { slug, present: true, problems: [reason] };
  }
  const shape = decisionMapProblem(parsed);
  if (shape !== undefined) {
    append(shape);
    return { slug, present: true, problems: [shape] };
  }
  const problems: string[] = [];
  const record = parsed as Record<string, { at: string }>;
  for (const key of Object.keys(record).sort()) {
    if (!isDecisionTime(record[key]!.at)) {
      const reason = `the decision for ${JSON.stringify(key)} has a time that is not the ISO instant the server stamps: ${JSON.stringify(record[key]!.at)}`;
      append(reason);
      problems.push(reason);
    }
  }
  return { slug, present: true, problems };
}

/**
 * The plan's reports, pools and decisions for every campaign the scan found
 * importable, appending every problem to the run's refusal list — never
 * removing a campaign (D223).
 */
export async function assemblePlan(ctx: StepContext, scan: ScanResult): Promise<PlanAssembled> {
  const refusals: PlanRefusal[] = [...scan.refusals];
  const reports: ReportPlan[] = [];
  const pools: PoolPlan[] = [];
  const decisions: DecisionPlan[] = [];
  for (const campaign of scan.campaigns) {
    reports.push(await reportPlan(ctx, refusals, campaign));
    pools.push(await poolPlan(ctx, refusals, campaign));
    decisions.push(await decisionPlan(ctx, refusals, campaign));
  }
  return { reports, pools, decisions, refusals };
}
