import { pathToFileURL } from "node:url";
import { parseLaneVerifyArgs, type LaneVerifyArgs } from "./lib/args.js";
import { emit, type EmitOutcome } from "./lib/emit.js";
import {
  EXIT_FAILED,
  EXIT_OK,
  EXIT_REFUSED,
  LaneVerifyRefusal,
  errorText,
  partialRun,
} from "./lib/errors.js";
import {
  onSignal,
  newSignalState,
  type SignalIo,
  type SignalName,
  type SignalState,
} from "./lib/signals.js";
import { renderDiagnostics, renderTable, verifyLane, type VerifyIo } from "./lib/verify.js";
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
 * Exit codes: 0 every step ran, every one of them passed, and every covered file
 * is at 100; 1 a step failed, a step was SKIPPED, a covered file is under 100, or
 * the run broke; 2 the command line is wrong, or the worktree is REFUSED — the
 * main checkout, a dirty one, or one whose `node_modules` cannot answer for the
 * branch. 2 is reserved for "this tool will not touch your worktree": nothing was
 * checked out, so a 2 always leaves the directory exactly as it was found.
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
    // A thrown run is a run that happened, and a wave whose lane was dispatched
    // against this branch needs to hear that. The event is written BEFORE the
    // exit code is chosen, so a refusal and a crash are both on the wave rather
    // than leaving a hole in it that reads exactly like a lane that was never
    // verified — or, worse, one that was verified and passed.
    const refused = error instanceof LaneVerifyRefusal;
    io.logError(`lane:verify: ${refused ? "refusing to verify: " : ""}${errorText(error)}`);
    if (plan.emit !== null) {
      const partial = partialRun(error);
      await emit(plan.emit, plan.logdir, "failed", { error: errorText(error), ...partial }, io);
    }
    // The verdict leads, as it does below: an emit that could not be written is
    // already on stderr, and it must not replace a refusal (2) or a crash (1)
    // with a code that says the command line was wrong or nothing at all.
    return refused ? EXIT_REFUSED : EXIT_FAILED;
  }

  io.log(renderTable(outcome.rows));
  io.log(
    outcome.verified === null
      ? "verified: nothing was checked out"
      : `verified ${outcome.verified}`,
  );
  // Under the table, not in it: the tails of the red steps. A table stays one line
  // per step however bad the run was, and an operator reading the exit code first
  // still finds the reason a few lines below it.
  const diagnostics = renderDiagnostics(outcome.diagnostics);
  if (diagnostics !== "") io.log(diagnostics);
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

/* istanbul ignore next -- CLI entry: the thin wrapper over node:child_process,
   node:fs/promises and process signals, plus the entry guard and the signal
   wiring. runCli() and every branch it feeds are covered directly in tests, and
   onSignal() — which holds every decision this block makes — is covered in
   tools/lane-verify/__tests__/signals.test.ts. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { execFile } = await import("node:child_process");
  const { readFile, rm } = await import("node:fs/promises");
  const signals = newSignalState();
  // The plan is parsed twice: once here, to learn the worktree before anything
  // runs, and once inside runCli, which is the one that decides the exit code.
  // A parse failure leaves the worktree unknown, which the signal path reads as
  // "nothing was checked out" — correct, because a command line that was never
  // acted on cannot have checked anything out.
  try {
    signals.cwd = parseLaneVerifyArgs(process.argv.slice(2)).worktree;
  } catch {
    signals.cwd = null;
  }

  /** How long to wait for a signalled child before restoring anyway. */
  const EXIT_WAIT_MS = 30_000;

  /**
   * `execFile` as this tool's runner: a numeric error code is the exit status of
   * a process that ran, and anything else is a launch failure, which REJECTS so
   * that it reads as a launch failure rather than as a test that failed.
   */
  const exec = (
    command: string,
    args: readonly string[],
    cwd: string,
    maxBuffer: number,
  ): Promise<RunResult> =>
    new Promise<RunResult>((resolvePromise, rejectPromise) => {
      let child: unknown;
      try {
        child = execFile(command, [...args], { cwd, maxBuffer }, (error, stdout, stderr) => {
          if (error === null) {
            resolvePromise({ code: 0, stdout, stderr });
            return;
          }
          const code = (error as NodeJS.ErrnoException & { code?: number | string }).code;
          if (typeof code !== "number") {
            rejectPromise(error);
            return;
          }
          resolvePromise({ code, stdout, stderr });
        });
      } catch (error) {
        rejectPromise(error);
        return;
      }
      // Published as the child is spawned, so a Ctrl-C arriving during a
      // four-minute coverage run has a pid to wait for. It is NOT cleared when
      // the child ends, and does not need to be: `waitForExit` resolves at once
      // for a pid that is already gone, which is the right answer for a signal
      // that lands between two commands.
      const pid = (child as { pid?: number } | null)?.pid;
      if (typeof pid === "number") signals.child = { pid, cwd };
    });

  runCli({
    argv: process.argv.slice(2),
    log: (text) => console.log(text),
    logError: (text) => console.error(text),
    readFile: (path) => readFile(path, "utf8"),
    // `force` because the file is usually NOT there — a fresh worktree, or one
    // whose last lane wrote none. Without it every run would fail its unlink on
    // the common case, and the step that exists to make the coverage read
    // trustworthy would itself be the reason a lane could not be verified.
    removeFile: (path) => rm(path, { force: true }),
    latch: signals.latch,
    onRecord: (recorded, cwd) => {
      signals.recorded = recorded;
      signals.cwd = cwd;
    },
    // `maxBuffer` because the one call whose output this tool reads is a coverage
    // run, and istanbul's own per-file table is comfortably larger than execFile's
    // 1MB default. A truncated stream would be reported by node as ENOBUFS and
    // read here as a test failure that did not happen.
    run: (command, args, options) => exec(command, args, options.cwd, 64 * 1024 * 1024),
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(`lane:verify: ${errorText(error)}`);
      process.exitCode = EXIT_FAILED;
    });

  const signalIo: SignalIo = {
    run: (command, args, options) => exec(command, args, options.cwd, 1024 * 1024),
    log: (text) => console.log(text),
    logError: (text) => console.error(text),
    // The child was in the terminal's process group and got the same signal, so
    // it is already on its way out; this polls rather than racing it. The bound
    // exists because a child that ignores SIGINT — vitest waiting on a wedged
    // worker — must not hold the worktree detached for ever.
    waitForExit: (pid) =>
      new Promise<void>((resolveWait) => {
        const deadline = Date.now() + EXIT_WAIT_MS;
        const poll = (): void => {
          let alive = true;
          try {
            process.kill(pid, 0);
          } catch {
            alive = false;
          }
          if (!alive || Date.now() >= deadline) {
            resolveWait();
            return;
          }
          setTimeout(poll, 50);
        };
        poll();
      }),
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      onSignal(signal, signals, signalIo).then(
        (code) => process.exit(code),
        (error: unknown) => {
          console.error(`lane:verify: ${errorText(error)}`);
          process.exit(EXIT_FAILED);
        },
      );
    });
  }
}
