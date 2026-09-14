/**
 * A review thread exactly as the fetch returns it: the node id the resolve
 * mutation takes, and the state the guardrail checks before it posts.
 */
export interface ThreadState {
  readonly id: string;
  readonly isResolved: boolean;
}

/**
 * A thread as fetched, named by the first comment — `mergeGate` refuses an
 * unresolved one by author and excerpt, because an id alone tells the operator
 * nothing about which finding is still open.
 */
export interface ReviewThread extends ThreadState {
  /** Login of the first comment's author, or "unknown" when the API omits one. */
  readonly author: string;
  /** The first comment's body, flattened and shortened enough to recognise. */
  readonly excerpt: string;
  /** The first comment's full body — attribution matches against it, not the excerpt. */
  readonly body: string;
}

/** The pull request shape the fetch response is expected to carry. */
export interface PullRequestShape {
  readonly data?: {
    readonly repository?: {
      readonly pullRequest?: {
        readonly id?: string;
        readonly reviewThreads?: {
          readonly pageInfo?: {
            readonly hasNextPage?: boolean;
            readonly endCursor?: string | null;
          };
          readonly nodes?: readonly {
            readonly id: string;
            readonly isResolved: boolean;
            readonly comments?: {
              readonly nodes?: readonly {
                readonly author?: { readonly login?: string } | null;
                readonly body?: string;
              }[];
            };
          }[];
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
