/**
 * How `lane:verify` reports a failure, in one place.
 *
 * The three codes are the tool's contract, and the split is the one the whole
 * design turns on: 2 means this tool will not touch the worktree at all (a
 * command line it cannot act on, or a worktree it refuses to verify), 1 means
 * it did the work and something was wrong, 0 means every step passed and every
 * covered file was at 100.
 */

/** Every step passed and every covered file is at 100. */
export const EXIT_OK = 0;
/** A step failed, or a covered file is under 100 in any of the four metrics. */
export const EXIT_FAILED = 1;
/** The command line is wrong, or the worktree is refused before any git writes. */
export const EXIT_REFUSED = 2;

/**
 * A refusal: this run will not proceed, and it says which rule stopped it.
 *
 * A distinct type rather than a bare `Error` because it is the ONLY failure
 * that can be raised both before and after the first git call, and the two need
 * different exit codes. A runner that cannot be launched, a vitest step that
 * throws — those are 1, "the check did not pass". Refusing the MAIN worktree,
 * or a dirty tree, is 2: the operator pointed this tool at the wrong tree, and
 * answering 1 would read as "the lane failed its gate", which is a different and
 * much worse conclusion to draw from an exit code.
 */
export class LaneVerifyRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaneVerifyRefusal";
  }
}

/** The message of a thrown thing, whether or not it was thrown as an `Error`. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
