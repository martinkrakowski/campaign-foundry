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
   * Rejects an unsafe campaign id. The revision guard is the caller's, as the
   * report store's is.
   */
  writeDecisions(campaignId: string, decisions: DecisionMap): Promise<string>;
}
