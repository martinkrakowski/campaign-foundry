/**
 * Where the human-in-the-loop review is recorded (PT-0d, D173 stamped).
 *
 * The approve/reject decisions used to live only in one browser's
 * localStorage, cleared on every brief switch and carrying no actor or time,
 * so a compliance product had no record that review happened (finding H4).
 * Each decision is now a record the server keeps, per campaign, with who made
 * it and when.
 */

/** A reviewer's verdict on one creative. */
export type Verdict = "approved" | "rejected";

/** One decision: the verdict, who gave it, and when (ISO-8601). */
export interface DecisionRecord {
  readonly verdict: Verdict;
  readonly actor: string;
  readonly at: string;
}

/** A campaign's decisions, keyed by the creative's review key (`assetKey`). */
export type DecisionMap = Readonly<Record<string, DecisionRecord>>;

export interface DecisionStorePort {
  /**
   * A campaign's decisions; `{}` when none are recorded or the id is not a safe
   * campaign id. A record that exists but cannot be read or parsed rejects: it
   * is not the same as having no decisions.
   */
  readDecisions(campaignId: string): Promise<DecisionMap>;
  /** Replace a campaign's decisions, atomically. Rejects an unsafe campaign id. */
  writeDecisions(campaignId: string, decisions: DecisionMap): Promise<void>;
}
