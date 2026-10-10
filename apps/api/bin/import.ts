import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { writeFile, type FileHandle } from "node:fs/promises";
import { errorMessage } from "@campaignfoundry/shared";
import { database, resetDatabase } from "../server/lib/db/database.js";
import { databaseSettings, storeBackend, objectStore } from "../server/lib/config.js";
import { resolveSource, type SourceFlags } from "../server/lib/import/source.js";
import {
  applyCampaigns,
  applyGuards,
  checkResultPath,
  describeResultRefusal,
  openResult,
  planProbes,
  replan,
  ResultWriter,
  type CampaignEntry,
  type PlanProbe,
} from "../server/lib/import/apply.js";
import { IMPORT_STEPS } from "../server/lib/import/steps.js";
import type { HashedContext } from "../server/lib/import/campaign-step.js";
import { scanBriefs } from "../server/lib/import/scan.js";
import { assemblePlan } from "../server/lib/import/plan.js";
import { assembleCensus } from "../server/lib/import/census.js";
import { digestSourceFiles, planDigest } from "../server/lib/import/digest.js";

/**
 * The PT-8 data-migration CLI (D217, D225).
 *
 *   yarn import plan [--project-root <dir>] [--output-root <dir>] [--org <id>]
 *                    --switched-at <iso> [--include-samples] [--out <path>]
 *
 * **`plan` is read-only (D225) and is the only subcommand that does anything yet.** It resolves
 * the source, probes the target read-only, and prints what the tree holds: every campaign
 * found with its refs classified, its legacy report fields, pool and decisions, every
 * refusal with the reason it was refused, the D227 census, and the D225 digest. It writes
 * NOTHING to the tree it reads — no row, no object, no file under `briefs/`, `assets/` or
 * `<output>/`. Its own stdout is the only write in the lane, plus the `--out <path>` file
 * when the flag is given: that file is the machine-readable plan (`loadEnv()` logs an
 * `[env] …` line on a real stdout before the header, so piped stdout is not parseable).
 *
 * `apply` and `verify` exist as refusals so the CLI shape is settled before the code
 * behind it is (D225 puts the digest, `--expect` and the quiet target on `apply`), and
 * PT-8a2 extends this same file rather than adding a second entry point.
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
  " --org <id> --expect <digest> --result <path> [--include-samples]" +
  "\nexit codes:\n" +
  "  0  nothing was refused and nothing is partial\n" +
  "  1  at least one campaign is partial, or the run itself failed, or the run wrote at least one campaign and refused at least one\n" +
  "  3  the run wrote nothing: at least one campaign was refused before any write, none was created or completed, nothing is partial";

/** argv's flags, as {@link resolveSource} takes them — plus the flag each subcommand owns. */
type ParsedFlags = SourceFlags & {
  readonly out?: string;
  readonly expect?: string;
  readonly result?: string;
};

/** A refused subcommand's exact stderr, so a caller can key on it (req 4's habit). */
const NOT_YET_IMPLEMENTED = "not yet implemented";

export interface ImportIO {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

/** argv's flags, as {@link resolveSource} takes them. An unknown flag refuses the run. */
function parseFlags(subcommand: string, argv: readonly string[]): ParsedFlags | string {
  let flags: {
    projectRoot?: string;
    outputRoot?: string;
    org?: string;
    switchedAt?: string;
    out?: string;
    expect?: string;
    result?: string;
    includeSamples: boolean;
  } = { includeSamples: false };
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
    if (flag === "--project-root") flags = { ...flags, projectRoot: value };
    else if (flag === "--output-root") flags = { ...flags, outputRoot: value };
    else if (flag === "--org") flags = { ...flags, org: value };
    else if (flag === "--switched-at") flags = { ...flags, switchedAt: value };
    else if (flag === "--out") {
      if (subcommand !== "plan") return `${flag} is not a flag this command takes.`;
      flags = { ...flags, out: value };
    } else if (flag === "--expect") {
      if (subcommand !== "apply") return `${flag} is not a flag this command takes.`;
      flags = { ...flags, expect: value };
    } else if (flag === "--result") {
      if (subcommand !== "apply") return `${flag} is not a flag this command takes.`;
      flags = { ...flags, result: value };
    } else return `${flag} is not a flag this command takes.`;
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
    const census = await assembleCensus(ctx, result, named);
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
    if (backend === "postgres" && objectStore() === "s3") {
      probes = await planProbes(ctx, result.campaigns, expectedHashes);
    } else {
      probesSkipped = "needs STORE_BACKEND=postgres and OBJECT_STORE=s3";
    }
    const json = JSON.stringify({
      switchedAt: switchedAtIso,
      orgId: ctx.orgId,
      backend,
      includeSamples: ctx.includeSamples,
      campaigns: result.campaigns,
      refusals: assembled.refusals,
      samples: result.samples,
      reports: assembled.reports,
      pools: assembled.pools,
      decisions: assembled.decisions,
      census,
      digest,
      probes,
      probesSkipped,
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
      `${result.campaigns.length} importable, ${assembled.refusals.length} refused, ` +
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
    io.stderr(`could not close the database: ${errorMessage(error)}`);
  }
}

/** `apply` requires both a reviewed digest to match and a result path to write. */
const EXPECT_REQUIRED = "apply needs --expect <digest>";
const RESULT_REQUIRED = "apply needs --result <path>";

/**
 * `apply`: re-plan the source, refuse unless the re-planned digest equals
 * `--expect` (N1/D225), refuse unless the target is the postgres/s3 backend with
 * an org row (N2/D225), refuse a result path that already exists or sits under a
 * source root (N4/D229), then run each campaign through {@link IMPORT_STEPS} and
 * write the result file as it goes (D229/D221). Every refusal below runs before
 * the first write; the database is closed once in `finally`, as `plan` does.
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
    if (flags.expect === undefined) {
      io.stderr(EXPECT_REQUIRED);
      return 1;
    }
    if (flags.result === undefined) {
      io.stderr(RESULT_REQUIRED);
      return 1;
    }
    const guard = applyGuards();
    if (guard !== undefined) {
      io.stderr(guard);
      return 1;
    }
    const outcome = await resolveSource(flags);
    if (!outcome.ok) {
      io.stderr(outcome.reason);
      return 1;
    }
    const { ctx, switchedAtIso } = outcome.source;
    const pathProblem = await checkResultPath(flags.result, ctx);
    if (pathProblem !== undefined) {
      io.stderr(pathProblem);
      return 1;
    }
    const replanned = await replan(ctx);
    if (replanned.digest !== flags.expect) {
      io.stderr(
        `--expect ${flags.expect} does not match the re-planned digest ${replanned.digest}`,
      );
      return 1;
    }
    if (existsSync(flags.result!)) {
      io.stderr(await describeResultRefusal(flags.result!));
      return 1;
    }
    handle = await openResult(flags.result!);
    const writer = new ResultWriter(handle, switchedAtIso, ctx.orgId, replanned.digest);
    const hashedCtx: HashedContext = { ...ctx, expectedHashes: replanned.expectedHashes };
    const resultPath = flags.result;
    await writer.header();
    for (const refusal of replanned.result.refusals) {
      const slug = refusal.slug ?? refusal.sourcePath;
      io.stdout(`${slug}: refused: ${refusal.reason}`);
      try {
        await writer.add({
          slug,
          outcome: "refused",
          reason: refusal.reason,
          minted: { assets: [] },
          unreferencedInputs: { count: 0, names: [] },
        });
      } catch (error) {
        const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
        throw new Error(
          `could not write the result file ${JSON.stringify(resultPath)}` +
            (code ? ` (${code})` : "") +
            `: ${errorMessage(error)}`,
        );
      }
    }
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
        try {
          await writer.add(entry);
        } catch (error) {
          const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
          throw new Error(
            `could not write the result file ${JSON.stringify(resultPath)}` +
              (code ? ` (${code})` : "") +
              `: ${errorMessage(error)}`,
          );
        }
      },
    );
    // Refusals happen before any write: either at the scan (the campaign never
    // reaches `applyCampaigns`) or inside it (a step returned `refused` or threw,
    // which is recorded as refused+partial and counted under `partial`). Nothing
    // of a refused campaign's is written, so they share one census figure.
    const refused = replanned.result.refusals.length + counts.refused;
    await writer.summary({ ...counts, refused });
    io.stdout(
      `${counts.created} created, ${counts.completed} completed, ` +
        `${counts.unchanged} unchanged, ${refused} refused`,
    );
    if (counts.partial) return 1;
    if (refused > 0) {
      io.stdout(`${refused} campaign(s) refused; nothing of theirs was written`);
      return counts.created + counts.completed === 0 ? 3 : 1;
    }
    return 0;
  } catch (error) {
    io.stderr(errorMessage(error));
    return 1;
  } finally {
    if (handle !== undefined) await handle.close();
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
  if (subcommand === "verify") {
    deps.stderr(`${subcommand}: ${NOT_YET_IMPLEMENTED}`);
    return 1;
  }
  deps.stderr(USAGE);
  return 1;
}

/* istanbul ignore next -- CLI entry guard; main() is covered directly in tests */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
