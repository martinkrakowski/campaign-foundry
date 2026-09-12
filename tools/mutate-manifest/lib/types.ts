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

export type CheckStatus = "verified" | "mismatch";

export interface MutationCheck {
  readonly mutation: ManifestMutation;
  readonly status: CheckStatus;
  readonly observed: Verdict;
}
