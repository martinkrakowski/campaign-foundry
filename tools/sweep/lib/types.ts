/**
 * A review thread exactly as the fetch returns it: the node id the resolve
 * mutation takes, and the state the guardrail checks before it posts.
 */
export interface ThreadState {
  readonly id: string;
  readonly isResolved: boolean;
}

/** The pull request shape the fetch response is expected to carry. */
export interface PullRequestShape {
  readonly data?: {
    readonly repository?: {
      readonly pullRequest?: {
        readonly id?: string;
        readonly reviewThreads?: {
          readonly nodes?: readonly { readonly id: string; readonly isResolved: boolean }[];
        };
      };
    };
  };
}

/** What one run decided: the class it verified, or the url it wrote. */
export interface SweepOutcome {
  readonly pr: number;
  readonly classIds: readonly string[];
  readonly commentUrl: string | null;
  readonly resolvedThreadIds: readonly string[];
}

/**
 * The `--post` gate refused: the reasons say which ids were not open
 * threads on the PR. A refusal is the normal answer to a wrong id list —
 * not a crash, and never a partial write.
 */
export class SweepRefusal extends Error {
  readonly reasons: readonly string[];

  constructor(message: string, reasons: readonly string[]) {
    super(message);
    this.name = "SweepRefusal";
    this.reasons = reasons;
  }
}
