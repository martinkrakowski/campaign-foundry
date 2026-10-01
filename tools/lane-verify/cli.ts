import { pathToFileURL } from "node:url";
import { parseLaneVerifyArgs, type LaneVerifyArgs } from "./lib/args.js";
import { emit, type EmitOutcome } from "./lib/emit.js";
import { EXIT_FAILED, EXIT_OK, EXIT_REFUSED, LaneVerifyRefusal, errorText } from "./lib/errors.js";
import { renderTable, verifyLane, type VerifyIo } from "./lib/verify.js";
import type { RunResult } from "./lib/types.js";

/**
 * Everything `runCli` touches outside itself, injected. A test supplies all of
 * it, so no test under this directory can check out a branch, move a git ref,
 * run vitest or write a wave event.
 */
export interface LaneVerifyCliIo extends VerifyIo {
  readonly argv: readonly string[];
  readonly log: (text: string) => void;
  readonly logError: (text: string) => void;
}

/**
 * `lane:verify --worktree <abs> --branch <b> --project <p> --cover <glob>…
 * [--test <path>…] [--emit <wave> <lane>] [--logdir <dir>]`
 *
 * Exit codes: 0 every step passed and every covered file is at 100; 1 a step
 * failed, or a covered file is under 100, or the run itself broke; 2 the
 * command line is wrong, or the worktree is REFUSED — the main checkout, a dirty
 * one, or one whose `node_modules` cannot answer for the branch. 2 is reserved
 * for "this tool will not touch your worktree": nothing was checked out, so a 2
 * always leaves the directory exactly as it was found.
 */
export async function runCli(io: LaneVerifyCliIo): Promise<number> {
  let plan: LaneVerifyArgs;
  try {
    plan = parseLaneVerifyArgs(io.argv);
  } catch (error) {
    io.logError(`lane:verify: ${errorText(error)}`);
    return EXIT_REFUSED;
  }

  let outcome: Awaited<ReturnType<typeof verifyLane>>;
  try {
    outcome = await verifyLane(plan, io);
  } catch (error) {
    // The two failures that are not a red step. A refusal is the operator's
    // command line or their worktree, and it is 2; anything else is this tool
    // failing to do its job on a worktree it was allowed to touch, which is 1.
    io.logError(
      error instanceof LaneVerifyRefusal
        ? `lane:verify: refusing to verify: ${error.message}`
        : `lane:verify: ${errorText(error)}`,
    );
    return error instanceof LaneVerifyRefusal ? EXIT_REFUSED : EXIT_FAILED;
  }

  io.log(renderTable(outcome.rows));
  io.log(
    outcome.verified === null
      ? "verified: nothing was checked out"
      : `verified ${outcome.verified}`,
  );
  if (plan.emit === null) return outcome.code;

  // The emit runs AFTER the restore, which the `finally` in verifyLane has
  // already completed: a wave-event.sh that could not be run must not be able to
  // leave the operator's worktree detached, and the detail it carries is the
  // finished table either way.
  const eventOutcome: EmitOutcome = outcome.code === EXIT_OK ? "settled" : "failed";
  const emitted = await emit(
    plan.emit,
    plan.logdir,
    eventOutcome,
    { steps: outcome.rows, verified: outcome.verified },
    io,
  );
  // The verify verdict leads. An emit that failed while the branch was already
  // red would otherwise replace "the lane did not pass" with "the event did not
  // write", which is the more urgent of the two being the quieter one. Only when
  // the check itself was green does the script's own code stand as the answer —
  // and then it is the only thing wrong.
  return outcome.code !== EXIT_OK ? outcome.code : emitted;
}

/* istanbul ignore next -- CLI entry: the thin wrapper over node:child_process
   and node:fs/promises, plus the entry guard. runCli() and every branch it
   feeds are covered directly in tests. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { execFile } = await import("node:child_process");
  const { readFile } = await import("node:fs/promises");
  runCli({
    argv: process.argv.slice(2),
    log: (text) => console.log(text),
    logError: (text) => console.error(text),
    readFile: (path) => readFile(path, "utf8"),
    // `maxBuffer` because the one call whose output this tool reads is a
    // coverage run, and istanbul's own per-file table is comfortably larger
    // than execFile's 1MB default. A truncated stream would be reported by
    // node as ENOBUFS and read here as a test failure that did not happen.
    run: (command, args, options) =>
      new Promise<RunResult>((resolvePromise, rejectPromise) => {
        execFile(
          command,
          [...args],
          { cwd: options.cwd, maxBuffer: 64 * 1024 * 1024 },
          (error, stdout, stderr) => {
            if (error === null) {
              resolvePromise({ code: 0, stdout, stderr });
              return;
            }
            // A number is the exit status of a process that ran and failed, and
            // it is this tool's normal answer for a red step. Anything else
            // means it never launched (ENOENT, EACCES), where there is no status
            // to report and the launch failure is the whole answer — so it
            // REJECTS, and the catch at the bottom prints it as the reason.
            const code = (error as NodeJS.ErrnoException & { code?: number | string }).code;
            if (typeof code !== "number") {
              rejectPromise(error);
              return;
            }
            resolvePromise({ code, stdout, stderr });
          },
        );
      }),
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(`lane:verify: ${errorText(error)}`);
      process.exitCode = EXIT_FAILED;
    });
}
