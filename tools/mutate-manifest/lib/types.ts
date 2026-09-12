import type { Verdict } from "../../mutate/lib/types.js";

/**
 * One mutation a lane claims its tests catch, recorded so that anyone — a
 * reviewer, CI, a later reader — can re-run it instead of believing it.
 *
 * `before` and `after` are the literal texts, inline. They are small, and a
 * manifest that pointed at scratch files would stop being replayable the moment
 * those files were cleaned up, which is the day it matters.
 */
export interface ManifestMutation {
  readonly file: string;
  readonly before: string;
  readonly after: string;
  readonly because: string;
  readonly command: readonly string[];
  readonly verdict: Verdict;
}

export interface Manifest {
  readonly version: 1;
  readonly lane: string;
  readonly mutations: readonly ManifestMutation[];
}

/**
 * `red-baseline` — the command already fails with the source untouched, so its
 * exit code says nothing about the mutation. `launch-failure` — the command
 * never ran at all. Both are findings about the branch under test, not about
 * the claim, and neither is a verdict.
 */
export type CheckStatus = "verified" | "mismatch" | "red-baseline" | "launch-failure";

export interface MutationCheck {
  readonly mutation: ManifestMutation;
  readonly status: CheckStatus;
  /** Absent unless the mutation actually ran: a blocked check observes nothing. */
  readonly observed?: Verdict;
  /** Set only with `launch-failure` — why there was no exit code to read. */
  readonly launchError?: string;
}
