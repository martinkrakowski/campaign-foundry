import { restore, type Recorded } from "./git.js";
import { errorText } from "./errors.js";
import type { ProcessRunner, RestoreLatch } from "./types.js";

/**
 * What happens when the operator hits Ctrl-C.
 *
 * A `finally` does not run when node is killed by a signal, and that is the whole
 * bug: a coverage run interrupted with Ctrl-C — the most natural thing to do when
 * a suite takes four minutes and has produced nothing — used to leave the
 * operator's worktree on a detached HEAD with their branch pointed at by nothing.
 * The fix is a handler that does the restore the `finally` was going to do, and
 * then exits 130.
 *
 * The handler is a function here rather than a wall of `process.on` in the entry
 * wrapper, because the entry wrapper is the one part of this tool no test can
 * reach. Everything this file decides — whether the child is waited for, whether
 * the restore runs once or twice, which exit code each signal produces — is
 * testable because it is not written in the part that cannot be.
 */

/** What a terminal sends for Ctrl-C, and what a `kill` sends for a stop. */
export type SignalName = "SIGINT" | "SIGTERM";

/** 128 plus the signal number, which is the convention every shell reports. */
export const EXIT_SIGINT = 130;
export const EXIT_SIGTERM = 143;

/** The child in flight, as far as the signal path needs to know. */
export interface ChildRef {
  readonly pid: number;
  readonly cwd: string;
}

/**
 * Everything the signal path needs that the run does not own, published by the
 * entry wrapper as the run learns it.
 *
 * One object rather than four arguments, because the alternative is a closure
 * the handler captures and a test cannot construct. `restored` is the same latch
 * the run's `finally` uses, which is what makes the two of them safe against each
 * other.
 */
export interface SignalState {
  /** The worktree under test, known from the parsed plan. */
  cwd: string | null;
  /** The HEAD and branch to go back to, published the moment they are recorded. */
  recorded: Recorded | null;
  /** The child currently running, published when each command is spawned. */
  child: ChildRef | null;
  /** Set by the run's `finally` and by this file; whoever gets there first wins. */
  latch: RestoreLatch;
  /** Set while a handler is working, so a second Ctrl-C does not start a second. */
  handling: boolean;
}

export function newSignalState(): SignalState {
  return { cwd: null, recorded: null, child: null, latch: { restored: false }, handling: false };
}

export interface SignalIo {
  readonly run: ProcessRunner;
  readonly log: (text: string) => void;
  readonly logError: (text: string) => void;
  /** Resolves once the child in flight has exited. */
  readonly waitForExit: (pid: number) => Promise<void>;
}

/**
 * Handles one signal: wait for the child, restore the worktree once, and return
 * the code the process should exit with.
 *
 * Three things happen in this order and the order is the whole design.
 *
 * **The child is waited for before the restore.** Ctrl-C at a terminal goes to
 * the whole foreground process group, so the vitest child has already been
 * signalled and is on its way out — but "on its way out" is not "out", and a
 * `git checkout` racing a vitest that is still writing its coverage directory
 * restores a tree underneath a process that is about to write to it again. The
 * wait is why the handler is async.
 *
 * **The latch decides who restores.** The run's `finally` does not normally run
 * here, but it can: once this handler has replaced node's default, the process
 * does not die on the signal, so an in-flight `verifyLane` is still pending and
 * its `finally` becomes reachable. Both would restore; the latch means one does
 * and the other reports the step as skipped.
 *
 * **The exit code is 128 + the signal number**, which is what a shell reports
 * for the same thing, so a caller cannot tell this apart from a process the
 * signal killed — except that this one left the worktree behind it.
 */
export async function onSignal(
  signal: SignalName,
  state: SignalState,
  io: SignalIo,
): Promise<number> {
  const code = signal === "SIGINT" ? EXIT_SIGINT : EXIT_SIGTERM;
  if (state.handling) {
    // A second signal while the first is still working. The entry's handler ends
    // the process with whatever this returns, so the second Ctrl-C wins and the
    // restore in flight is abandoned — which is what an operator who presses it
    // twice is asking for, and the price of it is named rather than discovered.
    io.logError(
      `lane:verify: ${signal} again — ending the process now; the restore in flight is abandoned and the worktree may be left on the lane branch`,
    );
    return code;
  }
  state.handling = true;
  const child = state.child;
  state.child = null;
  if (child !== null) {
    io.log(`lane:verify: ${signal} — waiting for the running command to exit`);
    await io.waitForExit(child.pid);
  }

  const { cwd, recorded, latch } = state;
  if (recorded === null || cwd === null) {
    io.log(`lane:verify: ${signal} — nothing had been checked out, so there is nothing to restore`);
    return code;
  }
  if (latch.restored) {
    io.log(`lane:verify: ${signal} — the worktree had already been restored`);
    return code;
  }
  latch.restored = true;
  try {
    const result = await restore(cwd, io.run, recorded);
    // The same column shape as the table's, so the line an operator reads after a
    // Ctrl-C looks like the rows they were reading when they pressed it.
    const label = result.code === 0 ? String(result.code) : `FAILED ${result.code}`;
    io.log(`restore ${label.padStart(7)}  (${signal})`);
    if (result.code !== 0) {
      io.logError(
        `lane:verify: the restore exited ${result.code} — ${cwd} may still be on the lane branch`,
      );
    }
  } catch (error) {
    // The exit code is still the signal's. The operator asked to stop, and the
    // fact that the stop also went wrong is a line on stderr, not a different
    // kind of exit: a caller reading 2 here would think the command line was
    // refused, which it was not.
    io.logError(
      `lane:verify: the restore could not be run: ${errorText(error)} — ${cwd} may still be on the lane branch`,
    );
  }
  return code;
}
