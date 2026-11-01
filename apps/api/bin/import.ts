import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { writeFile, type FileHandle } from "node:fs/promises";
import { errorMessage } from "@campaignfoundry/shared";
import { database, resetDatabase } from "../server/lib/db/database.js";
import {
  databaseSettings,
  objectStoreSettings,
  storeBackend,
  objectStore,
} from "../server/lib/config.js";
import { resolveSource, type SourceFlags } from "../server/lib/import/source.js";
import { importTenant } from "../server/lib/import/import-tenant.js";
import {
  VERIFY_ENTITIES,
  verifyTarget,
  type VerifyStores,
  type VerifyTargetReport,
} from "../server/lib/import/verify.js";
import { objectStoreClient } from "../server/lib/object-store/index.js";
import {
  getAssetStore,
  getBriefStore,
  getDecisionStore,
  getPoolStore,
  getReportStore,
} from "../server/lib/ports/index.js";
import {
  applyCampaigns,
  applyGuards,
  checkResultPath,
  describeResultRefusal,
  entryNotes,
  exitCodeFor,
  openResult,
  planProbes,
  replan,
  ResultWriter,
  type ApplyCounts,
  type CampaignEntry,
  type PlanProbe,
  type ReplanResult,
} from "../server/lib/import/apply.js";
import {
  applyExistingNormalise,
  checkExistingDigest,
  replanExisting,
  type ExistingReplan,
} from "../server/lib/import/existing-apply.js";
import type { NormaliseResult } from "../server/lib/import/normalise-step.js";
import type { StepContext } from "../server/lib/import/steps.js";
import { IMPORT_STEPS } from "../server/lib/import/steps.js";
import { planRenderProbes } from "../server/lib/import/renders-plan.js";
import { renderFingerprints } from "../server/lib/import/render-file.js";
import type { RenderContext } from "../server/lib/import/renders-step.js";
import { scanBriefs } from "../server/lib/import/scan.js";
import { assemblePlan, unreferencedInputsPlan } from "../server/lib/import/plan.js";
import { assembleCensus } from "../server/lib/import/census.js";
import { digestSourceFiles, planDigest } from "../server/lib/import/digest.js";
import {
  planExistingCampaigns,
  type ExistingCampaignsPlan,
} from "../server/lib/import/existing-campaigns.js";

/**
 * The PT-8 data-migration CLI (D217, D225).
 *
 *   yarn import plan [--project-root <dir>] [--output-root <dir>] [--org <id>]
 *                    --switched-at <iso> [--include-samples] [--out <path>]
 *
 * **`plan` is read-only (D225).** It resolves the source, probes the target
 * read-only, and prints what the tree holds: every campaign found with its refs
 * classified, its legacy report fields, pool and decisions, every refusal with the
 * reason it was refused, the D227 census, and the D225 digest. It writes NOTHING
 * to the tree it reads — no row, no object, no file under `briefs/`, `assets/` or
 * `<output>/`. Its own stdout is the only write in the lane, plus the `--out <path>` file
 * when the flag is given: that file is the machine-readable plan (`loadEnv()` logs an
 * `[env] …` line on a real stdout before the header, so piped stdout is not parseable).
 *
 * `apply` writes the import; `verify` (PT-8f3) re-plans and read-only verifies the
 * plan and the whole org, exiting 1 on any mismatch.
 */
export const USAGE =
  "usage: yarn import plan --switched-at <iso> [--project-root <dir>] [--output-root <dir>]" +
  " [--org <id>] [--include-samples] [--out <path>]";

/**
 * The `apply` usage and its exit-code contract, printed by `apply --help`
 * (D229/D221). A job definition reads the codes, so they are stated here verbatim.
 */
export const APPLY_USAGE =
  "usage: yarn import apply --switched-at <iso> --project-root <dir> --output-root <dir>" +
  " --org <id> --expect <digest> [--expect-existing <digest>] --result <path> [--include-samples]" +
  "\nexit codes:\n" +
  "  0  nothing was refused and nothing is partial\n" +
  "  1  at least one campaign is partial (a write of it failed, or one of its report, pool or decision rows was refused, or one of its renders is missing, was refused or failed), or the run itself failed, or the run wrote something and refused at least one campaign\n" +
  "  3  the run wrote nothing: at least one campaign was refused before any write, none was created or completed, no row was written, no render was created, nothing is partial";

/**
 * The `verify` usage and its exit-code contract, printed by `verify --help`
 * (PT-8f3). A job definition reads the codes, so they are stated here verbatim.
 */
export const VERIFY_USAGE =
  "usage: yarn import verify --switched-at <iso> [--project-root <dir>] [--output-root <dir>]" +
  " [--org <id>] [--include-samples] [--expect <digest>] [--out <path>]" +
  "\nexit codes:\n" +
  "  0  every planned and org-wide check matched\n" +
  "  1  at least one check mismatched, or the run itself was refused";

/**
 * The error `apply` stops with when a line of the result file cannot be written:
 * it names the file and the system's code, for a campaign's line and for a
 * scan refusal's line alike.
 */
function resultWriteError(resultPath: string | undefined, error: unknown): Error {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  return new Error(
    `could not write the result file ${JSON.stringify(resultPath)}` +
      (code ? ` (${code})` : "") +
      `: ${errorMessage(error)}`,
  );
}

/** argv's flags, as {@link resolveSource} takes them — plus the flag each subcommand owns. */
type ParsedFlags = SourceFlags & {
  readonly out?: string;
  readonly expect?: string;
  readonly expectExisting?: string;
  readonly result?: string;
};

export interface ImportIO {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

type MutableFlags = {
  projectRoot?: string;
  outputRoot?: string;
  org?: string;
  switchedAt?: string;
  out?: string;
  expect?: string;
  expectExisting?: string;
  result?: string;
  includeSamples: boolean;
};

const COMMON_VALUE_FLAGS: Readonly<Record<string, keyof MutableFlags>> = {
  "--project-root": "projectRoot",
  "--output-root": "outputRoot",
  "--org": "org",
  "--switched-at": "switchedAt",
};

const SUBCOMMAND_VALUE_FLAGS: Readonly<
  Record<string, { readonly cmd: readonly string[]; readonly key: keyof MutableFlags }>
> = {
  "--out": { cmd: ["plan", "verify"], key: "out" },
  "--expect": { cmd: ["apply", "verify"], key: "expect" },
  "--expect-existing": { cmd: ["apply"], key: "expectExisting" },
  "--result": { cmd: ["apply"], key: "result" },
};

function applyValueFlag(
  subcommand: string,
  flags: MutableFlags,
  flag: string,
  value: string,
): MutableFlags | string {
  const common = COMMON_VALUE_FLAGS[flag];
  if (common !== undefined) return { ...flags, [common]: value };
  const specific = SUBCOMMAND_VALUE_FLAGS[flag];
  if (specific === undefined || !specific.cmd.includes(subcommand)) {
    return `${flag} is not a flag this command takes.`;
  }
  return { ...flags, [specific.key]: value };
}

/** argv's flags, as {@link resolveSource} takes them. An unknown flag refuses the run. */
function parseFlags(subcommand: string, argv: readonly string[]): ParsedFlags | string {
  let flags: MutableFlags = { includeSamples: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === "--include-samples") {
      flags = { ...flags, includeSamples: true };
      continue;
    }
    const value = argv[i + 1];
    // A following FLAG is not a value: `--org --switched-at …` would otherwise make the org
    // `--switched-at` and then report the timestamp as an unknown flag (CodeRabbit on #681).
    if (value === undefined || value.startsWith("--")) return `${flag} needs a value.`;
    i++;
    const next = applyValueFlag(subcommand, flags, flag, value);
    if (typeof next === "string") return next;
    flags = next;
  }
  return flags;
}

/**
 * `plan`: source resolution, the read-only target probe, discovery, and the printed plan.
 *
 * **A refusal here is a RUN-level one and exits 1; per-campaign refusals do not** (the
 * row's item 9): a brief the parser refuses is a fact about the tree, and the reviewer
 * still needs the plan for everything else. Only a source this run cannot read is a
 * failure to have run at all.
 *
 * **`plan` NEVER REJECTS (fix round 1, FIX 2b).** The entry guard is
 * `main(...).then(code => { process.exitCode = code })` with no rejection handler, so any
 * throw below became an unhandled rejection: an abort, no exit code, no message, and no
 * plan. The per-file capture inside `scanBriefs` stops the throws we know about — a
 * circular brief, a bad ref, an unreadable file — and this catch stops the ones we do not,
 * including `storeBackend()` refusing a malformed `STORE_BACKEND` (`config.ts:43`), which
 * no amount of per-file handling can reach. The whole body is inside the try for that
 * reason, and the entry guard is left exactly as it is.
 */
async function plan(argv: readonly string[], io: ImportIO): Promise<number> {
  try {
    const flags = parseFlags("plan", argv);
    if (typeof flags === "string") {
      io.stderr(flags);
      return 1;
    }
    const outcome = await resolveSource(flags);
    if (!outcome.ok) {
      io.stderr(outcome.reason);
      return 1;
    }
    const { ctx, backend, switchedAtIso } = outcome.source;
    const result = await scanBriefs(ctx);
    const assembled = await assemblePlan(ctx, result);
    // Read-only, like the rest of `plan`: the own inputs no ref names (owner's decision,
    // 2026-10-11). They are not imported and not in the digest; a folder that cannot be
    // listed joins the refusal list instead of ending the plan.
    const unreferenced = unreferencedInputsPlan(ctx, result);
    const refusals = [...assembled.refusals, ...unreferenced.refusals];
    // The renders a report row names (req 13's lexical resolutions, refused or
    // not) are what separate an orphan render from a named one (D223); the OK
    // ones are what the import would WRITE, and the digest fingerprints them.
    const named = new Set(
      assembled.reports.flatMap((report) =>
        report.fields.flatMap((field) => (field.resolved === null ? [] : [field.resolved])),
      ),
    );
    const planned = new Set(
      assembled.reports.flatMap((report) =>
        report.fields.flatMap((field) => (field.status === "ok" ? [field.resolved] : [])),
      ),
    );
    const census = await assembleCensus(ctx, result, named, unreferenced.entries);
    const files = await digestSourceFiles(ctx, result, planned);
    const digest = planDigest({
      files,
      orgId: ctx.orgId,
      switchedAt: ctx.switchedAt.toISOString(),
      includeSamples: ctx.includeSamples,
    });
    // D225 read-only probes are only meaningful against the live target: a plan
    // whose target is the file stores has no campaign rows to probe, so it
    // reports why the probes were skipped rather than null-ing them silently.
    const expectedHashes = new Map<string, string>();
    for (const file of files) {
      if (file.sha256 !== undefined) expectedHashes.set(file.rel, file.sha256);
    }
    let probes: readonly PlanProbe[] | null = null;
    let probesSkipped: string | null = null;
    // Class (P), D228: read from the target like the probes, so outside the digest.
    let existingCampaigns: ExistingCampaignsPlan | null = null;
    if (backend === "postgres" && objectStore() === "s3") {
      // What `apply` would do with each render a report names (PT-8d): read from
      // the target after the digest was computed, so never part of it.
      probes = await planRenderProbes(
        ctx,
        await planProbes(ctx, result.campaigns, expectedHashes),
        assembled.reports,
        files,
      );
      existingCampaigns = await planExistingCampaigns(database(), ctx);
    } else {
      probesSkipped = "needs STORE_BACKEND=postgres and OBJECT_STORE=s3";
    }
    const json = JSON.stringify({
      switchedAt: switchedAtIso,
      orgId: ctx.orgId,
      backend,
      includeSamples: ctx.includeSamples,
      campaigns: result.campaigns,
      refusals,
      samples: result.samples,
      reports: assembled.reports,
      pools: assembled.pools,
      decisions: assembled.decisions,
      unreferencedInputs: unreferenced.entries,
      census,
      digest,
      probes,
      probesSkipped,
      existingCampaigns,
    });
    // The `--out` write happens BEFORE anything is printed: a failed write
    // throws into the catch below — exit 1, nothing printed, no partial file —
    // while a run-level refusal above returns before any write at all.
    if (flags.out !== undefined) {
      await writeFile(flags.out, `${json}\n`, { encoding: "utf8" });
    }
    io.stdout(`import plan — switched-at: ${switchedAtIso}`);
    io.stdout(`org: ${ctx.orgId}`);
    io.stdout(`backend: ${backend}`);
    io.stdout(json);
    io.stdout(
      `${result.campaigns.length} importable, ${refusals.length} refused, ` +
        `digest ${digest.slice(0, 12)}`,
    );
    return 0;
  } catch (error) {
    io.stderr(errorMessage(error));
    return 1;
  } finally {
    await closeDatabase(io);
  }
}

/**
 * End the pool this run may have opened, in a finally that always runs (req
 * 20): a fs-only run never opened one, and a failed probe names its own
 * problem — so a close that cannot is swallowed here rather than masking it.
 * `resetDatabase()` runs in a finally of its own, so a REJECTING `end()` still
 * uninstalls the client and a second in-process `main()` builds a fresh pool;
 * the failure itself is named on stderr, and never changes the plan's code.
 */
async function closeDatabase(io: ImportIO): Promise<void> {
  try {
    if (storeBackend() === "postgres" && databaseSettings().url !== undefined) {
      try {
        await database().end();
      } finally {
        resetDatabase();
      }
    }
  } catch (error) {
    io.stderr(redactSecrets(`could not close the database: ${errorMessage(error)}`));
  }
}

/** `apply` requires both a reviewed digest to match and a result path to write. */
const EXPECT_REQUIRED = "apply needs --expect <digest>";
const RESULT_REQUIRED = "apply needs --result <path>";

/** Wrap one result-file write so a failure names the file and the system's code. */
async function writeWithResultGuard(
  resultPath: string,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    throw resultWriteError(resultPath, error);
  }
}

/** Print one class-(P) normalisation entry on stdout (PT-8e3). */
function printNormaliseEntry(io: ImportIO, entry: NormaliseResult): void {
  const why = entry.reason ? `: ${entry.reason}` : "";
  io.stdout(`${entry.slug}: existing ${entry.status}${why}`);
  if (entry.minted.assets.length > 0) {
    io.stdout(`  minted: campaign ${entry.campaignId}, ${entry.minted.assets.length} asset(s)`);
    for (const asset of entry.minted.assets) {
      io.stdout(`    asset ${asset.id} ${asset.name} ${asset.key}`);
    }
  }
  for (const skipped of entry.notImported) {
    io.stdout(`  input ${skipped.name}: not imported: ${skipped.reason}`);
  }
}

interface ValidatedApply {
  readonly ctx: StepContext;
  readonly switchedAtIso: string;
}

/** The run-level refusals that must all pass before `apply` writes anything. */
async function validateApplyPreconditions(flags: ParsedFlags): Promise<ValidatedApply | string> {
  if (flags.expect === undefined) return EXPECT_REQUIRED;
  if (flags.result === undefined) return RESULT_REQUIRED;
  const guard = applyGuards();
  if (guard !== undefined) return guard;
  const outcome = await resolveSource(flags);
  if (!outcome.ok) return outcome.reason;
  const { ctx, switchedAtIso } = outcome.source;
  const pathProblem = await checkResultPath(flags.result, ctx);
  if (pathProblem !== undefined) return pathProblem;
  return { ctx, switchedAtIso };
}

/** Run the apply body after the guard rails have passed: campaigns, then class-(P) normalisation. */
async function runApplyBody(
  writer: ResultWriter,
  resultPath: string,
  io: ImportIO,
  ctx: StepContext,
  replanned: ReplanResult,
  existingReplanned: ExistingReplan,
): Promise<number> {
  const hashedCtx: RenderContext = {
    ...ctx,
    expectedHashes: replanned.expectedHashes,
    renderFingerprints: renderFingerprints(replanned.files),
  };
  await writer.header();
  for (const refusal of replanned.result.refusals) {
    const slug = refusal.slug ?? refusal.sourcePath;
    io.stdout(`${slug}: refused: ${refusal.reason}`);
    await writeWithResultGuard(resultPath, () =>
      writer.add({
        slug,
        outcome: "refused",
        reason: refusal.reason,
        minted: { assets: [] },
        unreferencedInputs: { count: 0, names: [] },
      }),
    );
  }
  const onMinted = async (
    slug: string,
    object: { readonly key: string; readonly path: string },
  ) => {
    io.stdout(`${slug}: minted render ${object.path} ${object.key}`);
    await writeWithResultGuard(resultPath, () => writer.object(object));
  };
  const counts = await applyCampaigns(
    hashedCtx,
    replanned.result.campaigns,
    IMPORT_STEPS,
    async (entry: CampaignEntry) => {
      io.stdout(`${entry.slug}: ${entry.outcome}${entry.reason ? `: ${entry.reason}` : ""}`);
      if (entry.minted.assets.length > 0) {
        io.stdout(
          `  minted: campaign ${entry.minted.campaignId}, ${entry.minted.assets.length} asset(s)`,
        );
        for (const asset of entry.minted.assets) {
          io.stdout(`    asset ${asset.id} ${asset.name} ${asset.key}`);
        }
      }
      for (const note of entryNotes(entry)) io.stdout(note);
      await writeWithResultGuard(resultPath, () => writer.add(entry));
    },
    onMinted,
  );
  const normCounts = await applyExistingNormalise(
    database(),
    ctx,
    existingReplanned,
    async (entry) => {
      printNormaliseEntry(io, entry);
      await writeWithResultGuard(resultPath, () => writer.existing(entry));
    },
  );
  const refused = replanned.result.refusals.length + counts.refused + normCounts.refused;
  const merged: ApplyCounts = {
    ...counts,
    refused,
    partial: counts.partial || normCounts.partial,
    objectsMinted: counts.objectsMinted + normCounts.assetsMinted,
    ...(normCounts.normalised > 0 ? { normalised: normCounts.normalised } : {}),
  };
  await writer.summary(merged);
  io.stdout(
    `${counts.created} created, ${counts.completed} completed, ` +
      `${counts.unchanged} unchanged, ${refused} refused`,
  );
  if (normCounts.normalised > 0) {
    io.stdout(`${normCounts.normalised} existing campaign(s) normalised`);
  }
  if (!merged.partial && refused > 0) {
    io.stdout(`${refused} campaign(s) refused; nothing of theirs was written`);
  }
  return exitCodeFor(merged, refused);
}

/**
 * `apply`: re-plan the source, refuse unless the re-planned digest equals
 * `--expect` (N1/D225), refuse unless the target is the postgres/s3 backend with
 * an org row (N2/D225), refuse a result path that already exists or sits under a
 * source root (N4/D229), then run each campaign through {@link IMPORT_STEPS} and
 * write the result file as it goes (D229/D221). Class-(P) normalisation runs
 * behind the second digest (`--expect-existing`, D225/D228) before `--result`
 * is opened. Every refusal below runs before the first write; the database is
 * closed once in `finally`, as `plan` does.
 */
async function apply(argv: readonly string[], io: ImportIO): Promise<number> {
  if (argv.includes("--help")) {
    io.stdout(APPLY_USAGE);
    return 0;
  }
  let handle: FileHandle | undefined;
  try {
    const flags = parseFlags("apply", argv);
    if (typeof flags === "string") {
      io.stderr(flags);
      return 1;
    }
    const validated = await validateApplyPreconditions(flags);
    if (typeof validated === "string") {
      io.stderr(validated);
      return 1;
    }
    const { ctx, switchedAtIso } = validated;
    const replanned = await replan(ctx);
    if (replanned.digest !== flags.expect) {
      io.stderr(
        `--expect ${flags.expect} does not match the re-planned digest ${replanned.digest}`,
      );
      return 1;
    }
    const existingReplanned = await replanExisting(database(), ctx);
    const existingProblem = checkExistingDigest(existingReplanned, flags.expectExisting);
    if (existingProblem !== undefined) {
      io.stderr(existingProblem);
      return 1;
    }
    if (existsSync(flags.result!)) {
      io.stderr(await describeResultRefusal(flags.result!));
      return 1;
    }
    handle = await openResult(flags.result!);
    const writer = new ResultWriter(handle, switchedAtIso, ctx.orgId, replanned.digest);
    return await runApplyBody(writer, flags.result!, io, ctx, replanned, existingReplanned);
  } catch (error) {
    io.stderr(errorMessage(error));
    return 1;
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch (error) {
        io.stderr(`could not close the result file: ${errorMessage(error)}`);
      }
    }
    await closeDatabase(io);
  }
}

/** The two backend guards (PT-8f3): `verify` READS rows and objects, so the target must be postgres + s3. */
function verifyGuards(): string | undefined {
  if (storeBackend() !== "postgres") {
    return `verify needs STORE_BACKEND=postgres, and STORE_BACKEND is ${storeBackend()}`;
  }
  if (objectStore() !== "s3") {
    return `verify needs OBJECT_STORE=s3, and OBJECT_STORE is ${objectStore()}`;
  }
  return undefined;
}

/** The target's stores, as `verify` reads them: the import tenant's, plus the process object store. */
function buildVerifyStores(orgId: string): VerifyStores {
  const scope = importTenant(orgId);
  return {
    briefs: getBriefStore(scope),
    assets: getAssetStore(scope),
    reports: getReportStore(scope),
    pools: getPoolStore(scope),
    decisions: getDecisionStore(scope),
    objects: objectStoreClient(),
  };
}

/**
 * Remove the configured credentials from a line `verify` prints: the password of
 * `DATABASE_URL` (both raw and decoded) and the S3 secret access key, when either
 * is set. A line can carry them only through an error message; a setting that cannot
 * be read or parsed contributes no secret and is ignored rather than masking the
 * error it accompanies.
 */
function redactSecrets(text: string): string {
  let redacted = text;
  const url = databaseSettings().url;
  if (url !== undefined) {
    try {
      const parsed = new URL(url);
      const passwords = new Set<string>();
      if (parsed.password !== "") {
        passwords.add(parsed.password);
        try {
          const decoded = decodeURIComponent(parsed.password);
          passwords.add(decoded);
        } catch {
          // An un-decodable password contributes only its encoded form.
        }
      }
      const rawMatch = /:\/\/[^:@/]*:([^@/]*)@/.exec(url);
      if (rawMatch && rawMatch[1] !== "") {
        passwords.add(rawMatch[1]);
        try {
          const decoded = decodeURIComponent(rawMatch[1]);
          passwords.add(decoded);
        } catch {
          // An un-decodable password contributes only its encoded form.
        }
      }
      for (const password of Array.from(passwords)) {
        passwords.add(encodeURIComponent(password));
        passwords.add(JSON.stringify(password).slice(1, -1));
      }
      const sorted = Array.from(passwords).sort((a, b) => b.length - a.length);
      for (const password of sorted) {
        redacted = redacted.split(password).join("[redacted]");
      }
    } catch {
      // An unparseable DATABASE_URL contributes no password to redact.
    }
  }
  try {
    const secret = objectStoreSettings()?.secretAccessKey;
    if (secret !== undefined && secret !== "") {
      const secrets = new Set<string>();
      secrets.add(secret);
      secrets.add(encodeURIComponent(secret));
      secrets.add(JSON.stringify(secret).slice(1, -1));
      const sorted = Array.from(secrets).sort((a, b) => b.length - a.length);
      for (const s of sorted) {
        redacted = redacted.split(s).join("[redacted]");
      }
    }
  } catch {
    // A misconfigured object store contributes no secret to redact.
  }
  return redacted;
}

/** Print one verify report: the header, per-entity counts, and every mismatch line. */
function printVerifyReport(
  io: ImportIO,
  switchedAtIso: string,
  orgId: string,
  digest: string,
  report: VerifyTargetReport,
): void {
  const line = (text: string): void => io.stdout(redactSecrets(text));
  line(`import verify — switched-at: ${switchedAtIso}`);
  line(`org: ${orgId}`);
  line(`digest: ${digest}`);
  for (const entity of VERIFY_ENTITIES) {
    const count = report.counts[entity];
    line(
      `${entity}: ${count.checked} checked, ${count.matched} matched, ` +
        `${count.checked - count.matched} mismatched`,
    );
  }
  for (const check of report.checks) {
    if (check.status !== "mismatch") continue;
    line(
      `${check.slug}${check.item ? ` (${check.item})` : ""}: ${check.entity} mismatch: ${check.reason}`,
    );
  }
  // `orgChecks` holds only mismatches: `verifyOrg` pushes a check only when it
  // found one (actor, path ref, asset id, parse failure), so nothing here needs
  // a status filter the way the plan's checks above do.
  for (const check of report.orgChecks) {
    line(
      `org: ${check.slug}${check.item ? ` (${check.item})` : ""}: ${check.entity} mismatch: ${check.reason}`,
    );
  }
  line(
    `org: ${report.orgCounts.campaigns} campaigns, ${report.orgCounts.briefVersions} versions, ` +
      `${report.orgCounts.assets} assets`,
  );
  line(`verify ${report.ok ? "ok" : "FAILED"}`);
}

/**
 * `verify`: re-plan the source, then read-only verify the plan AND the whole
 * org (PT-8f3). It writes ZERO rows, objects and files under the roots: only
 * `--out <path>` (when given) and its own streams are written. Exit 0 when
 * every planned and org-wide check matched; 1 on any mismatch or refusal.
 */
async function verify(argv: readonly string[], io: ImportIO): Promise<number> {
  if (argv.includes("--help")) {
    io.stdout(VERIFY_USAGE);
    return 0;
  }
  try {
    const flags = parseFlags("verify", argv);
    if (typeof flags === "string") {
      io.stderr(redactSecrets(flags));
      return 1;
    }
    const guard = verifyGuards();
    if (guard !== undefined) {
      io.stderr(redactSecrets(guard));
      return 1;
    }
    const outcome = await resolveSource(flags);
    if (!outcome.ok) {
      io.stderr(redactSecrets(outcome.reason));
      return 1;
    }
    const { ctx, switchedAtIso } = outcome.source;
    if (flags.out !== undefined) {
      const pathProblem = await checkResultPath(flags.out, ctx);
      if (pathProblem !== undefined) {
        io.stderr(redactSecrets(pathProblem.replace(/^--result/, "--out")));
        return 1;
      }
    }
    const replanned = await replan(ctx);
    if (flags.expect !== undefined && replanned.digest !== flags.expect) {
      io.stderr(
        redactSecrets(
          `verify: --expect ${flags.expect} differs from re-planned digest ${replanned.digest}`,
        ),
      );
      return 1;
    }
    const report = await verifyTarget(database(), buildVerifyStores(ctx.orgId), ctx, replanned);
    const json = JSON.stringify(
      {
        switchedAt: switchedAtIso,
        orgId: ctx.orgId,
        digest: replanned.digest,
        ok: report.ok,
        counts: report.counts,
        orgCounts: report.orgCounts,
        checks: report.checks,
        orgChecks: report.orgChecks,
      },
      (_key: string, value: unknown): unknown =>
        typeof value === "string" ? redactSecrets(value) : value,
    );
    // The `--out` write happens BEFORE anything is printed: a failed write
    // throws into the catch below — exit 1, nothing printed, no partial file.
    if (flags.out !== undefined) {
      await writeFile(flags.out, `${json}\n`, { encoding: "utf8", flag: "wx" });
    }
    printVerifyReport(io, switchedAtIso, ctx.orgId, replanned.digest, report);
    return report.ok ? 0 : 1;
  } catch (error) {
    io.stderr(redactSecrets(errorMessage(error)));
    return 1;
  } finally {
    await closeDatabase(io);
  }
}

/**
 * `yarn import <subcommand> …` — `0` on success (no refusal, nothing partial),
 * `1` when at least one campaign is partial or the run itself failed, `3` when
 * nothing is partial but at least one campaign was refused before any write.
 *
 * **Never calls `process.exit`**: the entry guard sets `process.exitCode` from this
 * number instead, so a caller (and the tests) own the exit and `main` stays a plain
 * `number`-returning function.
 */
export async function main(
  argv: readonly string[],
  deps: ImportIO = { stdout: console.log, stderr: console.error },
): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (subcommand === "plan") return plan(rest, deps);
  if (subcommand === "apply") return apply(rest, deps);
  if (subcommand === "verify") return verify(rest, deps);
  deps.stderr(USAGE);
  return 1;
}

/* istanbul ignore next -- CLI entry guard; main() is covered directly in tests */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
