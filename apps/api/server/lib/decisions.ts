import { getDecisionStore } from "./ports/index.js";
import {
  DecisionConflictError,
  type DecisionMap,
  type DecisionRecord,
  type DecisionStorePort,
  type Verdict,
} from "./ports/decision-store.port.js";
import type { StorageScope } from "./run-environment.js";

export type { DecisionMap, DecisionRecord, Verdict };

/** The most review keys one campaign's decisions may hold. */
export const MAX_DECISIONS = 5000;

/**
 * The next stored decisions, given the reviewer's whole verdict map (D173).
 *
 * A key whose verdict is unchanged keeps its original actor, time and run, so
 * the record says who decided, when and against what, not who last saved. A
 * new or changed verdict is stamped with this actor, time and run. A key
 * absent from `verdicts` is back in review and drops out.
 */
export function applyVerdicts(
  previous: DecisionMap,
  verdicts: Readonly<Record<string, Verdict>>,
  actor: string,
  at: string,
  run: string,
): DecisionMap {
  // A null prototype: a submitted `__proto__` key is stored, not a prototype swap.
  const next = Object.create(null) as Record<string, DecisionRecord>;
  for (const [key, verdict] of Object.entries(verdicts)) {
    const kept = Object.hasOwn(previous, key) ? previous[key] : undefined;
    next[key] = kept !== undefined && kept.verdict === verdict ? kept : { verdict, actor, at, run };
  }
  return next;
}

/** The tail of each campaign's queue of decision work, per store (so per root). */
const lockTails = new WeakMap<DecisionStorePort, Map<string, Promise<unknown>>>();

/**
 * Run `work` with the campaign's decision store, after every earlier call for
 * the same campaign and store has settled (D173).
 *
 * A save's compare-and-write and the report write's retirement are each a
 * read-modify-write of one record. Queued, a save cannot land between a
 * retirement and the report it makes way for, and two of them cannot restore
 * what the other removed. The lock is per process: the file adapter's phase
 * runs one API process, and the database adapter (PT-3) has transactions.
 */
export async function withDecisionLock<T>(
  scope: StorageScope,
  campaignId: string,
  work: (store: DecisionStorePort) => Promise<T>,
): Promise<T> {
  const store = getDecisionStore(scope);
  let tails = lockTails.get(store);
  if (tails === undefined) {
    tails = new Map();
    lockTails.set(store, tails);
  }
  const run = (tails.get(campaignId) ?? Promise.resolve()).then(() => work(store));
  const tail = run.catch(() => undefined);
  tails.set(campaignId, tail);
  try {
    return await run;
  } finally {
    if (tails.get(campaignId) === tail) tails.delete(campaignId);
  }
}

/**
 * Return replaced creatives to review (D173): drop the decisions for `keys`,
 * or every decision when `keys` is undefined (a full run replaces the report).
 *
 * The report write calls this under `withDecisionLock`, so a stale verdict
 * retires on the server, not in whichever tab ran the job: a second tab or a
 * reload never shows an approval given to a creative that has since been
 * replaced. Writes nothing when nothing is retired.
 */
export async function retireDecisions(
  store: DecisionStorePort,
  campaignId: string,
  keys?: ReadonlySet<string>,
): Promise<void> {
  // Written against the revision it read, so a save from another process that
  // lands in between is never overwritten: the retirement reads again and retries.
  for (let attempt = 1; ; attempt += 1) {
    const { decisions, revision } = await store.readDecisions(campaignId);
    const all = Object.keys(decisions);
    const retired = keys === undefined ? all : all.filter((key) => keys.has(key));
    if (retired.length === 0) return;
    const next = Object.create(null) as Record<string, DecisionRecord>;
    for (const key of all) if (!retired.includes(key)) next[key] = decisions[key];
    try {
      await store.writeDecisions(campaignId, next, revision);
      return;
    } catch (error) {
      if (!(error instanceof DecisionConflictError) || attempt >= RETIRE_ATTEMPTS) throw error;
    }
  }
}

/** How often a retirement re-reads after losing to a concurrent save before it fails the write. */
export const RETIRE_ATTEMPTS = 5;

/** Why a submitted verdict map cannot be stored, or undefined when it can. */
export function verdictsProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "decisions must be an object of review key to verdict";
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_DECISIONS) return `decisions may hold at most ${MAX_DECISIONS} keys`;
  for (const [key, verdict] of entries) {
    if (key.length === 0 || key.length > 200 || [...key].some((c) => c.charCodeAt(0) < 0x20)) {
      return `decision key ${JSON.stringify(key.slice(0, 40))} is not a review key`;
    }
    if (verdict !== "approved" && verdict !== "rejected") {
      return `decision for ${JSON.stringify(key)} must be "approved" or "rejected"`;
    }
  }
  return undefined;
}
