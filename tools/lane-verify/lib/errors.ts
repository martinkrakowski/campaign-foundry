import type { StepRow } from "./types.js";

/**
 * The two paths that must never be confused: a refusal, which is the operator's
 * command line or their worktree, and a crash, which is this tool failing to do
 * its job on a worktree it was allowed to touch.
 */

/** Every step passed and every covered file is at 100. */
export const EXIT_OK = 0;
/** A step failed, a step was skipped, a covered file is under 100, or the run broke. */
export const EXIT_FAILED = 1;
/** The command line is wrong, or the worktree is refused before any git writes. */
export const EXIT_REFUSED = 2;

/**
 * A refusal: this run will not proceed, and it says which rule stopped it.
 *
 * A distinct type rather than a bare `Error` because it is the ONLY failure that
 * can be raised before the first git call, and it is the one whose exit code is
 * 2. Refusing the MAIN worktree, or a dirty tree, is 2: the operator pointed
 * this tool at the wrong tree, and answering 1 would read as "the lane failed its
 * gate", which is a different and much worse conclusion to draw from an exit
 * code.
 */
export class LaneVerifyRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaneVerifyRefusal";
  }
}

/**
 * A crash: a command could not be run at all, and the run is over.
 *
 * It carries the rows gathered so far, because the run is not over for the
 * RECORD. Without them an interrupted or broken run emits no event at all — the
 * lane's gate simply never appears on the wave, which is the one thing a wave log
 * must never be silent about — and the table the operator would have seen is lost
 * with the exception.
 *
 * The recorded `verified` is carried for the same reason: a crash after the
 * coverage read happened still names the sha that was under test.
 */
export class LaneVerifyCrash extends Error {
  readonly rows: readonly StepRow[];
  readonly verified: string | null;

  constructor(message: string, rows: readonly StepRow[], verified: string | null) {
    super(message);
    this.name = "LaneVerifyCrash";
    this.rows = rows;
    this.verified = verified;
  }
}

/** The message of a thrown thing, whether or not it was thrown as an `Error`. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether a row counts towards a green run. `skipped` and `exit: null` never do.
 *
 * This predicate — not the exit code alone — is what decides the verdict, and it
 * is the single place that decision is made. A step this tool declined to run, or
 * whose command never reached a completion, is a step it did not check.
 */
export function isGreen(row: StepRow): boolean {
  return row.state === "ran" && row.exit === 0;
}

/** A row for a step this tool declined to run, and why. Never green. */
export function skippedRow(step: string, because: string): StepRow {
  return { step, state: "skipped", exit: null, key: `skipped: ${because}` };
}

/** The rows a thrown thing gathered, and the sha it had reached — or nothing. */
export function partialRun(error: unknown): {
  readonly steps: readonly StepRow[];
  readonly verified: string | null;
} {
  return error instanceof LaneVerifyCrash
    ? { steps: error.rows, verified: error.verified }
    : { steps: [], verified: null };
}
