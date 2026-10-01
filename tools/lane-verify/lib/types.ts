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
 * fetches, because the STDOUT of the coverage step is where the coverage
 * table lives and the STDERR of every step is where a refusal states its reason.
 * Both are read on the step that produced them, and neither is ever re-read.
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

/** One line of the table: what ran, what it exited, and the line worth reading. */
export interface StepRow {
  readonly step: string;
  readonly exit: number;
  readonly key: string;
}
