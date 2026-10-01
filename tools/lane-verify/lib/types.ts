/**
 * The shapes `lane:verify` passes across its own modules.
 *
 * `ProcessRunner` is the whole of this tool's contact with the outside world: it
 * is injected by `cli.ts` for a real run and by a recording fake in every test,
 * so no test in this directory can spawn a process, move a git ref or run vitest.
 */

/**
 * One process this tool ran: its exit code and both streams.
 *
 * The streams are part of the result rather than something the caller goes and
 * fetches, because the STDOUT of the coverage step is where the coverage table
 * lives, the STDERR of every step is where a refusal states its reason, and both
 * are what the last forty lines under the table are cut from. Both are read on
 * the step that produced them, and neither is ever re-read.
 */
export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * A command, its argv, and the directory it runs in.
 *
 * `cwd` is required on every call, never defaulted. This tool runs two very
 * different sets of commands in two very different directories — git and vitest
 * in the lane's worktree, `wave-event.sh` in this repository — and a call site
 * that forgot to say which would put a test run in the wrong tree or append a
 * lane's gate event to the wrong wave log. Making it un-optional is the cheaper
 * of the two mistakes.
 */
export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string },
) => Promise<RunResult>;

/**
 * Whether a row ran at all.
 *
 * `skipped` is a STATE and not an exit code, and it is never green: a step this
 * tool declined to run is a step it did not check, and reporting a run as
 * verified on the strength of the steps it skipped is the whole failure this
 * type exists to make impossible. It gets its own word in the table's exit
 * column and its own value in the emitted detail, so neither a reader at a
 * terminal nor a script reading the wave log can mistake it for a `0`.
 */
export type RowState = "ran" | "skipped";

/**
 * One line of the table: what ran, whether it ran, what it exited, and the line
 * worth reading.
 *
 * `exit` is null for a row that was skipped and for one whose command could not
 * be run to a completion — neither has an exit code, and both are non-green.
 */
export interface StepRow {
  readonly step: string;
  readonly state: RowState;
  readonly exit: number | null;
  readonly key: string;
}

/**
 * The tail of one red step's output, printed under the table.
 *
 * Only red steps have one. A green step's output is noise, and a table followed
 * by forty lines of scrollback nobody asked for is a report nobody reads.
 */
export interface Diagnostic {
  readonly step: string;
  readonly exit: number | null;
  readonly text: string;
}

/**
 * One-shot, shared between the run and the signal path.
 *
 * Both can reach the restore — the run's `finally` on every ordinary exit, the
 * SIGINT handler when the operator interrupts a coverage run — and a second
 * `git checkout` over a tree that is already back where it belongs is not
 * harmless, because a concurrent edit committed in between would be checked out
 * away. Whoever gets here first sets the flag; the other reports the step as
 * skipped rather than doing it twice.
 */
export interface RestoreLatch {
  restored: boolean;
}
