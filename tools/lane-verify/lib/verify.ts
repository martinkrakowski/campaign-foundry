import { join } from "node:path";
import { COVERAGE_SUMMARY, underHundred } from "./coverage.js";
import { EXIT_FAILED, EXIT_OK, errorText } from "./errors.js";
import {
  checkoutDetached,
  fetchBranch,
  recordHead,
  refuseDirtyWorktree,
  refuseMainWorktree,
  refuseStaleLock,
  restore,
} from "./git.js";
import type { LaneVerifyArgs } from "./args.js";
import type { ProcessRunner, RunResult, StepRow } from "./types.js";

/**
 * The run itself: four refusals, then the steps, then the restore, then the
 * table and the verdict.
 *
 * Nothing here touches `process`, a clock or a filesystem directly. The runner
 * and the one file read are injected, so a test drives the whole thing — every
 * refusal, every red step, the restore after a throw — with no repository and no
 * process at all.
 */

export interface VerifyIo {
  readonly run: ProcessRunner;
  readonly readFile: (path: string) => Promise<string>;
}

export interface VerifyOutcome {
  readonly code: number;
  readonly rows: readonly StepRow[];
  /** The sha that was checked out, or null when nothing was. */
  readonly verified: string | null;
}

/**
 * The one line of a step's output worth putting in the table: the last non-empty
 * line of stdout, and failing that of stderr, and failing that a flat admission.
 *
 * It is the SUMMARY line rather than the first, because that is where vitest
 * puts its file count, prettier its verdict and tsc its error count. stderr is
 * the fallback and not the primary because a red step has already said what went
 * wrong in its exit code, and the operator scrolls the real log for the rest —
 * a table that reprinted the first error line of every step would be a worse
 * summary than one that reprints nothing.
 */
export function keyLine(result: RunResult): string {
  const lines = (text: string): readonly string[] =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
  return lines(result.stdout).at(-1) ?? lines(result.stderr).at(-1) ?? "(no output)";
}

function stepRow(step: string, result: RunResult): StepRow {
  return { step, exit: result.code, key: keyLine(result) };
}

/**
 * The coverage step, which is a READ rather than a process.
 *
 * Both ways this can fail — no summary at all, and a summary that does not
 * parse — are exit 1 and not an exception, because they are answers about the
 * run rather than faults in it, and they belong in the table beside the step
 * that produced them. A missing summary is the common one: vitest writes
 * `coverage-summary.json` only when it got as far as reporting, so a compile
 * error in the branch leaves no file here, and reading a summary left over from
 * an EARLIER run would report coverage for code this run never measured.
 */
async function coverageRow(cwd: string, io: VerifyIo): Promise<StepRow> {
  let short: readonly string[];
  try {
    short = underHundred(await io.readFile(join(cwd, COVERAGE_SUMMARY)));
  } catch (error) {
    return {
      step: "coverage",
      exit: 1,
      key: `cannot use ${COVERAGE_SUMMARY}: ${errorText(error)}`,
    };
  }
  return short.length === 0
    ? {
        step: "coverage",
        exit: 0,
        key: "every covered file at 100% in lines, branches, functions and statements",
      }
    : {
        step: "coverage",
        exit: 1,
        key: `${short.length} file(s) under 100: ${short.join("; ")}`,
      };
}

/**
 * The vitest command line, as the row spells it:
 *
 *   yarn vitest run --project <p> --coverage --coverage.include=<each glob>
 *       --coverage.reporter=json-summary [<tests>]
 *
 * One `--coverage.include` per `--cover`, because the option is single-valued
 * and repeating the flag is how a glob list is passed — vitest unions the
 * includes, so one flag per glob and several globs means the union of exactly
 * the globs the operator named. `json-summary` is the only reporter asked for
 * because the question this tool asks of the output is answerable from the file
 * and not from a table that hides the files that passed.
 */
export function vitestArgv(plan: LaneVerifyArgs): readonly string[] {
  return [
    "vitest",
    "run",
    "--project",
    plan.project,
    "--coverage",
    ...plan.cover.map((glob) => `--coverage.include=${glob}`),
    "--coverage.reporter=json-summary",
    ...plan.test,
  ];
}

/**
 * Runs the check on a lane branch and ALWAYS puts the worktree back.
 *
 * The restore is in a `finally`, so it happens on the green path, on a red step,
 * on a coverage read that failed, and on a runner that THREW mid-run — the last
 * of which is the case a hand-run check gets wrong most often, because the
 * person who sees `yarn vitest` fail in their terminal reaches for Ctrl-C and
 * walks away from a worktree sitting on a detached HEAD.
 *
 * Every step runs even after an earlier one is red, so the table is the whole
 * answer in one pass rather than the first thing that broke. The restore's own
 * exit code is a row like any other: a worktree that could not be put back is
 * a real failure and the operator has to hear about it, not read past it.
 */
export async function verifyLane(plan: LaneVerifyArgs, io: VerifyIo): Promise<VerifyOutcome> {
  const cwd = plan.worktree;
  await refuseMainWorktree(cwd, io.run);
  await refuseDirtyWorktree(cwd, io.run);

  const rows: StepRow[] = [stepRow("fetch", await fetchBranch(cwd, io.run, plan.branch))];
  const recorded = await recordHead(cwd, io.run);
  await refuseStaleLock(cwd, io.run, recorded.head, plan.branch);

  let verified: string | null = null;
  try {
    const checkout = await checkoutDetached(cwd, io.run, plan.branch);
    rows.push(stepRow("checkout", checkout));
    if (checkout.code === 0) {
      // Asked only after a checkout that worked, so `verified` names a commit
      // this run actually tested. A `git rev-parse HEAD` on a failed checkout
      // would happily print the commit it was already on.
      const head = await io.run("git", ["rev-parse", "HEAD"], { cwd });
      rows.push(stepRow("head", head));
      if (head.code === 0) verified = head.stdout.trim();
    }
    rows.push(stepRow("tests", await io.run("yarn", vitestArgv(plan), { cwd })));
    rows.push(await coverageRow(cwd, io));
    rows.push(stepRow("typecheck", await io.run("yarn", ["typecheck"], { cwd })));
    rows.push(stepRow("format:check", await io.run("yarn", ["format:check"], { cwd })));
  } finally {
    rows.push(stepRow("restore", await restore(cwd, io.run, recorded)));
  }

  return {
    code: rows.some((row) => row.exit !== 0) ? EXIT_FAILED : EXIT_OK,
    rows,
    verified,
  };
}

/** The table: step, exit, key line — one line each, aligned on the first column. */
export function renderTable(rows: readonly StepRow[]): string {
  const width = Math.max(...rows.map((row) => row.step.length));
  return rows
    .map((row) => `${row.step.padEnd(width)}  ${String(row.exit).padStart(2)}  ${row.key}`)
    .join("\n");
}
