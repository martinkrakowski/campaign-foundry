import { getDecisionStore } from "./ports/index.js";
import type { DecisionMap, DecisionRecord, Verdict } from "./ports/decision-store.port.js";
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

/**
 * Return regenerated creatives to review (D173): drop the decisions for `keys`,
 * or every decision when `keys` is undefined (a full run replaces the report).
 *
 * The report write calls this, so a stale verdict retires on the server, not
 * in whichever tab ran the job: a second tab or a reload never shows an
 * approval given to a creative that has since been replaced. Writes nothing
 * when nothing is retired.
 */
export async function retireDecisions(
  scope: StorageScope,
  campaignId: string,
  keys?: ReadonlySet<string>,
): Promise<void> {
  const store = getDecisionStore(scope);
  const { decisions } = await store.readDecisions(campaignId);
  const all = Object.keys(decisions);
  const retired = keys === undefined ? all : all.filter((key) => keys.has(key));
  if (retired.length === 0) return;
  const next = Object.create(null) as Record<string, DecisionRecord>;
  for (const key of all) if (!retired.includes(key)) next[key] = decisions[key];
  await store.writeDecisions(campaignId, next);
}

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
