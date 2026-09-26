/**
 * Where the human-in-the-loop review is recorded (PT-0d, D173 stamped).
 *
 * The approve/reject decisions used to live only in one browser's
 * localStorage, cleared on every brief switch and carrying no actor or time,
 * so a compliance product had no record that review happened (finding H4).
 * Each decision is now a record the server keeps, per campaign, with who made
 * it, when, and against which run.
 */

/** A reviewer's verdict on one creative. */
export type Verdict = "approved" | "rejected";

/**
 * One decision: the verdict, who gave it, when (ISO-8601), and the run it was
 * given against — the revision of the campaign report the reviewer saw.
 */
export interface DecisionRecord {
  readonly verdict: Verdict;
  readonly actor: string;
  readonly at: string;
  readonly run: string;
}

/** A campaign's decisions, keyed by the creative's review key (`assetIdentity`). */
export type DecisionMap = Readonly<Record<string, DecisionRecord>>;

/**
 * A campaign's decisions and the revision of the record they were read from:
 * a SHA-256 of its bytes, or null when nothing is recorded. A writer names the
 * revision it read, so a second tab's stale save is a conflict (D173, D82).
 */
export interface StoredDecisions {
  readonly decisions: DecisionMap;
  readonly revision: string | null;
}

export interface DecisionStorePort {
  /**
   * A campaign's decisions; empty with a null revision when none are recorded
   * or the id is not a safe campaign id. A record that exists but cannot be
   * read, parsed, or is not a decision map rejects: it is not the same as
   * having no decisions.
   */
  readDecisions(campaignId: string): Promise<StoredDecisions>;
  /**
   * Replace a campaign's decisions, atomically, and answer the new revision.
   * Rejects an unsafe campaign id.
   *
   * With `expectedRevision` (null: none recorded yet), the write happens only if
   * the stored revision is still that one, checked in the same atomic step as the
   * write, and otherwise throws a `DecisionConflictError` carrying the current
   * revision: a save from a stale read never lands, whichever process made it.
   *
   * `fence` (PT-6a2, D171, D78): optional run id that fences the write. When
   * provided, the write is refused (throws `JobLeaseLostError`) if the run no
   * longer holds its lease (not running or lease lapsed). Without a fence,
   * today's behaviour is preserved (the decisions PUT passes none).
   */
  writeDecisions(
    campaignId: string,
    decisions: DecisionMap,
    expectedRevision?: string | null,
    fence?: { runId: string },
  ): Promise<string>;
}


/** A write whose expected revision is no longer the stored one (D82). */
export class DecisionConflictError extends Error {
  readonly code = "ECONFLICT";
  constructor(
    campaignId: string,
    /** The revision stored now (null: none). */
    readonly revision: string | null,
  ) {
    super(`The decisions for campaign "${campaignId}" changed since they were read.`);
  }
}

/**
 * Whether `at` is the one form a decision's time takes: `Date#toISOString()`
 * (UTC, milliseconds). The server stamps it so; a store keeps it exactly, so a
 * record reads back byte for byte and its revision is stable.
 */
export function isDecisionTime(at: string): boolean {
  const time = Date.parse(at);
  return !Number.isNaN(time) && new Date(time).toISOString() === at;
}
