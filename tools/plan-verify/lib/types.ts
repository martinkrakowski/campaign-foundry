/** A falsifiable claim a plan lane makes about the code it intends to change. */
export interface Premise {
  /** The plan file the premise was read from. */
  readonly plan: string;
  /** The lane the premise belongs to, from the fence info string. */
  readonly lane: string;
  /** A POSIX `sh` script. Exit 0 means the gap the lane describes is still open. */
  readonly script: string;
}

/**
 * `holds` — the script exited 0, so the lane still has work to do.
 * `stale` — it did not, so the gap has been closed by something else and the
 * lane would re-implement shipped behaviour.
 * `timed-out` — the script ran past its budget and was killed, so there is no
 * verdict. It is neither `holds` (that would hide a check that never finished)
 * nor `stale` (that would accuse a lane that may still be live).
 */
export type PremiseStatus = "holds" | "stale" | "timed-out";

export interface PremiseResult {
  readonly premise: Premise;
  readonly status: PremiseStatus;
  readonly exitCode: number;
  readonly output: string;
}

export interface VerifyDeps {
  readonly execute: (script: string) => Promise<{
    readonly exitCode: number;
    readonly output: string;
    /** True when the executor killed the script instead of the script finishing. */
    readonly timedOut?: boolean;
  }>;
}
