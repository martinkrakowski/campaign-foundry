import type { DecisionMap, DecisionRecord, Verdict } from "./ports/decision-store.port.js";

export type { DecisionMap, DecisionRecord, Verdict };

/** The most review keys one campaign's decisions may hold. */
export const MAX_DECISIONS = 5000;

/**
 * The next stored decisions, given the reviewer's whole verdict map (D173).
 *
 * A key whose verdict is unchanged keeps its original actor and time, so the
 * record says who decided and when, not who last saved. A new or changed
 * verdict is stamped with this actor and time. A key absent from `verdicts` is
 * back in review and drops out.
 */
export function applyVerdicts(
  previous: DecisionMap,
  verdicts: Readonly<Record<string, Verdict>>,
  actor: string,
  at: string,
): DecisionMap {
  const next: Record<string, DecisionRecord> = {};
  for (const [key, verdict] of Object.entries(verdicts)) {
    const kept = previous[key];
    next[key] = kept !== undefined && kept.verdict === verdict ? kept : { verdict, actor, at };
  }
  return next;
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
