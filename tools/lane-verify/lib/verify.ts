import { join } from "node:path";
import { COVERAGE_SUMMARY, measuredAnything, parseSummary, shortFiles } from "./coverage.js";
import { EXIT_FAILED, EXIT_OK, LaneVerifyCrash, errorText, isGreen, skippedRow } from "./errors.js";
import {
  checkoutDetached,
  fetchBranch,
  recordHead,
  refuseDirtyWorktree,
  refuseMainWorktree,
  refuseStaleLock,
  restore,
  type Recorded,
} from "./git.js";
import type { LaneVerifyArgs } from "./args.js";
import type { Diagnostic, ProcessRunner, RestoreLatch, RunResult, StepRow } from "./types.js";

/**
 * The run itself: the refusals, the steps, the restore, and the table.
 *
 * Nothing here touches `process`, a clock or a filesystem directly. The runner,
 * the one file read and the one unlink are injected, so a test drives the whole
 * thing — every refusal, every red step, every skip, the restore after a throw —
 * with no repository and no process at all.
 */

/** Every dependency the run needs, injected. */
export interface VerifyIo {
  readonly run: ProcessRunner;
  readonly readFile: (path: string) => Promise<string>;
  /** Unlink, used ONCE, to drop the summary an earlier run left behind. */
  readonly removeFile: (path: string) => Promise<void>;
  /** Shared with the signal path so the restore is attempted once. */
  readonly latch: RestoreLatch;
  /**
   * Told the recorded HEAD the moment it is known.
   *
   * This exists for the signal path and nowhere else: SIGINT arrives while the
   * run is inside a `try`, and the handler needs to know what to go back to. The
   * recorded value cannot be re-derived after a checkout — HEAD is then the
   * lane's commit, not the operator's — so publishing it is the only way a
   * handler can know, and NOT publishing it means an interrupted run leaves the
   * worktree detached with nothing able to say what it was on.
   */
  readonly onRecord: (recorded: Recorded, cwd: string) => void;
}

export interface VerifyOutcome {
  readonly code: number;
  readonly rows: readonly StepRow[];
  /** The sha that was checked out, or null when nothing was. */
  readonly verified: string | null;
  /** One entry per RED step: its output tail, for printing under the table. */
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * The steps that a failed `fetch` makes unverifiable, and the ones a failed
 * `checkout` does.
 *
 * `head` is in the first list and not the second because the two failures are
 * not the same. No fetch means nothing was checked out at all, so there is no
 * `git rev-parse HEAD` that would name the branch — the row would be skipped.
 * A failed checkout leaves HEAD on the previous commit, which IS readable, and a
 * `head` row there would print a sha as the sha under test when the branch was
 * never reached. Absence is the honest rendering for that one.
 */
const AFTER_FAILED_FETCH = [
  "checkout",
  "head",
  "tests",
  "coverage",
  "typecheck",
  "format:check",
] as const;
const AFTER_FAILED_CHECKOUT = ["tests", "coverage", "typecheck", "format:check"] as const;

/**
 * How many lines of a red step's output are printed under the table.
 *
 * Forty is enough for a tsc error list or a vitest failure block to be read at a
 * glance, and bounded on purpose: a coverage run's own output is thousands of
 * lines, and the report has to survive being pasted into a wave thread.
 */
const DIAGNOSTIC_TAIL_LINES = 40;

/**
 * The one line of a step's output worth putting in the table: the last non-empty
 * line of stdout, and failing that of stderr, and failing that a flat admission.
 *
 * It is the SUMMARY line rather than the first, because that is where vitest
 * puts its file count, prettier its verdict and tsc its error count. stderr is
 * the fallback and not the primary because the full tail of a red step is
 * printed underneath the table anyway.
 */
export function keyLine(result: RunResult): string {
  const lines = (text: string): readonly string[] =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
  return lines(result.stdout).at(-1) ?? lines(result.stderr).at(-1) ?? "(no output)";
}

/**
 * The last lines of a red step's two streams, blanks dropped.
 *
 * stdout first and then stderr, so a step that printed its summary and then its
 * reason reads in the order it happened. Dropping blank lines is what keeps the
 * bound on LINES rather than on characters, which is the thing that has to be
 * bounded: an unfiltered tail is dominated by the blank lines vitest and tsc
 * print between sections.
 */
export function diagnosticTail(result: RunResult): string {
  return [...result.stdout.split("\n"), ...result.stderr.split("\n")]
    .filter((line) => line.trim() !== "")
    .slice(-DIAGNOSTIC_TAIL_LINES)
    .join("\n");
}

/** One row for a step that ran. */
function ranRow(step: string, result: RunResult): StepRow {
  return { step, state: "ran", exit: result.code, key: keyLine(result) };
}

/**
 * The step that drops the summary an EARLIER run left in the worktree.
 *
 * Without it the run can report a previous run's numbers as its own, which is
 * the second way this tool could pass on code it did not measure: vitest writes
 * no summary at all when it fails to compile, the stale file from the last lane
 * is still sitting there, and every file in it is at 100.
 *
 * `ENOENT` is not a failure — there was nothing to remove, which is the state a
 * fresh worktree is in. Any OTHER unlink failure is red and, because a summary
 * this tool cannot delete is a summary it cannot trust, the coverage row is
 * skipped rather than read: see {@link coverageRow}'s caller.
 */
async function precleanRow(cwd: string, io: VerifyIo): Promise<StepRow> {
  try {
    await io.removeFile(join(cwd, COVERAGE_SUMMARY));
    return {
      step: "preclean",
      state: "ran",
      exit: 0,
      key: "removed the summary an earlier run left",
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") {
      return { step: "preclean", state: "ran", exit: 0, key: "no earlier summary to remove" };
    }
    return {
      step: "preclean",
      state: "ran",
      exit: null,
      key: `could not remove the earlier summary, so no summary can be trusted: ${errorText(error)}`,
    };
  }
}

/**
 * The coverage step, which is a READ rather than a process.
 *
 * Both ways this can fail — no summary at all, and a summary that does not
 * parse — are red and not an exception, because they are answers about the run
 * rather than faults in it. A missing summary is the common one: {@link
 * precleanRow} deleted whatever was there, so its absence now means vitest wrote
 * none, and the row says exactly that instead of reporting a coverage verdict
 * this run never reached.
 */
async function coverageRow(cwd: string, plan: LaneVerifyArgs, io: VerifyIo): Promise<StepRow> {
  const at = join(cwd, COVERAGE_SUMMARY);
  let parsed;
  try {
    parsed = parseSummary(await io.readFile(at));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return {
      step: "coverage",
      state: "ran",
      exit: null,
      key:
        code === "ENOENT"
          ? `vitest wrote no coverage summary at ${COVERAGE_SUMMARY}`
          : `cannot use ${COVERAGE_SUMMARY}: ${errorText(error)}`,
    };
  }
  if (!measuredAnything(parsed)) {
    return {
      step: "coverage",
      state: "ran",
      exit: null,
      key: `no file matched --cover ${plan.cover.join(" ")}`,
    };
  }
  const short = shortFiles(parsed);
  return short.length === 0
    ? {
        step: "coverage",
        state: "ran",
        exit: 0,
        key: "every covered file at 100% in lines, branches, functions and statements",
      }
    : {
        step: "coverage",
        state: "ran",
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
 * The restore, as a row — and never twice.
 *
 * The latch is what makes the `finally` and the SIGINT handler safe against each
 * other: whichever runs first restores and sets the flag, and the other reports
 * the step as skipped. Two `git checkout`s in a row over a tree an operator is
 * editing in would throw away whatever was written in between.
 *
 * A runner that throws here is caught rather than propagated, because a `finally`
 * that throws replaces whatever the body was already reporting, and the body is
 * usually the more useful account. The row is red either way.
 */
async function restoreRow(cwd: string, io: VerifyIo, recorded: Recorded): Promise<StepRow> {
  if (io.latch.restored) {
    return skippedRow("restore", "the signal path already restored this worktree");
  }
  io.latch.restored = true;
  try {
    return ranRow("restore", await restore(cwd, io.run, recorded));
  } catch (error) {
    return {
      step: "restore",
      state: "ran",
      exit: null,
      key: `the restore could not be run: ${errorText(error)} — ${cwd} may still be on the lane branch`,
    };
  }
}

/**
 * Runs the check on a lane branch and ALWAYS puts the worktree back.
 *
 * The restore is in a `finally`, so it happens on the green path, on a red step,
 * on a coverage read that failed, and on a runner that THREW mid-run.
 *
 * Every step runs even after an earlier one is red, so the table is the whole
 * answer in one pass rather than the first thing that broke — EXCEPT after a
 * `fetch` or a `checkout` that failed. Those two are different in kind: nothing
 * after them would measure the branch, so their rows are `skipped` rather than
 * red. Running the typecheck and the coverage of a worktree that is still sitting
 * on the operator's own commit would report this run's verdict on code it never
 * checked out, which is the one thing this tool exists not to do.
 *
 * A body that throws is re-thrown as a {@link LaneVerifyCrash} carrying the rows
 * gathered so far, AFTER the restore has run. The record of a crashed run is the
 * run's most valuable output, and a bare exception loses all of it.
 */
export async function verifyLane(plan: LaneVerifyArgs, io: VerifyIo): Promise<VerifyOutcome> {
  const cwd = plan.worktree;
  await refuseMainWorktree(cwd, io.run);
  await refuseDirtyWorktree(cwd, io.run);

  const fetch = await fetchBranch(cwd, io.run, plan.branch);
  const rows: StepRow[] = [ranRow("fetch", fetch)];
  const recorded = await recordHead(cwd, io.run);
  io.onRecord(recorded, cwd);
  // The lock is compared only when the ref it would be read from exists. A branch
  // that does not exist has no `origin/<branch>:yarn.lock` to compare against,
  // and answering that refusal instead would name a stale `node_modules` as the
  // reason when the real one is that there is no such branch.
  if (fetch.code === 0) {
    await refuseStaleLock(cwd, io.run, recorded.head, plan.branch);
  }

  let verified: string | null = null;
  let crash: { readonly error: unknown } | null = null;
  const diagnostics: Diagnostic[] = [];
  /** Records a step that ran, and keeps the tail of its output when it was red. */
  const ran = (step: string, result: RunResult): void => {
    rows.push(ranRow(step, result));
    if (result.code !== 0) {
      diagnostics.push({ step, exit: result.code, text: diagnosticTail(result) });
    }
  };
  try {
    if (fetch.code !== 0) {
      for (const step of AFTER_FAILED_FETCH) rows.push(skippedRow(step, "fetch failed"));
    } else {
      const checkout = await checkoutDetached(cwd, io.run, plan.branch);
      ran("checkout", checkout);
      if (checkout.code === 0) {
        // Asked only after a checkout that worked, so `verified` names a commit
        // this run actually tested. A `git rev-parse HEAD` on a failed checkout
        // would happily print the commit it was already on.
        const head = await io.run("git", ["rev-parse", "HEAD"], { cwd });
        ran("head", head);
        if (head.code === 0) verified = head.stdout.trim();

        const preclean = await precleanRow(cwd, io);
        rows.push(preclean);
        ran("tests", await io.run("yarn", vitestArgv(plan), { cwd }));
        rows.push(
          isGreen(preclean)
            ? await coverageRow(cwd, plan, io)
            : skippedRow(
                "coverage",
                "an earlier summary could not be removed, so none can be trusted",
              ),
        );
        ran("typecheck", await io.run("yarn", ["typecheck"], { cwd }));
        ran("format:check", await io.run("yarn", ["format:check"], { cwd }));
      } else {
        for (const step of AFTER_FAILED_CHECKOUT) rows.push(skippedRow(step, "checkout failed"));
      }
    }
  } catch (error) {
    crash = { error };
  } finally {
    rows.push(await restoreRow(cwd, io, recorded));
  }
  if (crash !== null) throw new LaneVerifyCrash(errorText(crash.error), rows, verified);

  return {
    code: rows.every(isGreen) ? EXIT_OK : EXIT_FAILED,
    rows,
    verified,
    diagnostics,
  };
}

/** The table: step, whether it ran and what it exited, key line — one line each. */
export function renderTable(rows: readonly StepRow[]): string {
  const width = Math.max(...rows.map((row) => row.step.length));
  return rows
    .map((row) => `${row.step.padEnd(width)}  ${exitColumn(row).padStart(7)}  ${row.key}`)
    .join("\n");
}

/**
 * The exit column. `skipped` is a WORD, not a code, precisely so it cannot be
 * mistaken for one — and `none` is the same argument for a command that never
 * reached a completion, which is red without having an exit status to show.
 */
function exitColumn(row: StepRow): string {
  if (row.state === "skipped") return "skipped";
  return row.exit === null ? "none" : String(row.exit);
}

/** The tails of the red steps, each under a heading naming the step. */
export function renderDiagnostics(diagnostics: readonly Diagnostic[]): string {
  return diagnostics
    .map(
      (diagnostic) =>
        `\n--- ${diagnostic.step} (${diagnostic.exit === null ? "no exit code" : `exit ${diagnostic.exit}`}) ---\n${diagnostic.text}`,
    )
    .join("\n");
}
