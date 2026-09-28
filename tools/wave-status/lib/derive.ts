import { asHashRecord, PLAN_REVIEW_LANE } from "../../plan-review/lib/rows.js";
import type { DerivedLane, LaneObservation, PlanReviewObservation, WaveEvent } from "./types.js";

export function parseLastExit(tail: string): number | undefined {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = /^\s*EXIT (\d+)\s*$/.exec(lines[i]);
    if (match) return Number(match[1]);
  }
  return undefined;
}

export function parseGateLog(text: string): {
  readonly exit?: number;
  readonly coverage?: {
    readonly statements: number;
    readonly branches: number;
    readonly functions: number;
    readonly lines: number;
  };
} {
  const lines = text.split("\n");

  let exit: number | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const gateMatch = /^\s*GATE EXIT (\d+)\s*$/.exec(line);
    const exitMatch = /^\s*EXIT (\d+)\s*$/.exec(line);
    if (gateMatch) {
      exit = Number(gateMatch[1]);
    } else if (exitMatch) {
      exit = Number(exitMatch[1]);
    }
    break;
  }

  let statements: number | undefined;
  let branches: number | undefined;
  let functions: number | undefined;
  let lineCount: number | undefined;
  for (const line of lines) {
    const stmt = /^\s*Statements\s*:\s*([\d.]+)%/.exec(line);
    if (stmt) statements = Number(stmt[1]);
    const br = /^\s*Branches\s*:\s*([\d.]+)%/.exec(line);
    if (br) branches = Number(br[1]);
    const fn = /^\s*Functions\s*:\s*([\d.]+)%/.exec(line);
    if (fn) functions = Number(fn[1]);
    const ln = /^\s*Lines\s*:\s*([\d.]+)%/.exec(line);
    if (ln) lineCount = Number(ln[1]);
  }

  const coverage =
    statements !== undefined &&
    branches !== undefined &&
    functions !== undefined &&
    lineCount !== undefined
      ? { statements, branches, functions, lines: lineCount }
      : undefined;

  return {
    ...(exit !== undefined ? { exit } : {}),
    ...(coverage !== undefined ? { coverage } : {}),
  };
}

export function deriveLane(obs: LaneObservation): DerivedLane {
  const exit = obs.log === undefined ? undefined : parseLastExit(obs.log.tail);
  const parsedGate = obs.gateLog === undefined ? undefined : parseGateLog(obs.gateLog);
  const gate =
    parsedGate !== undefined && (parsedGate.exit !== undefined || parsedGate.coverage !== undefined)
      ? parsedGate
      : undefined;
  const planReview = obs.planReview === undefined ? undefined : planReviewFlag(obs.planReview);

  return {
    ...(exit !== undefined ? { exit } : {}),
    ...(gate !== undefined ? { gate } : {}),
    ...(planReview !== undefined ? { planReview } : {}),
    alive: obs.alive,
    ...(obs.log !== undefined ? { log: obs.log } : {}),
    ...(obs.pr !== undefined ? { pr: obs.pr } : {}),
    ...(obs.diff !== undefined ? { diff: obs.diff } : {}),
  };
}

/**
 * The plan the wave's reviews were taken against: the `plan` the latest
 * `plan-review settled` event in the directory named. `undefined` when no
 * review was recorded there — there is no plan path to read, and the flag for
 * a dispatched lane is then exactly the no-review case.
 */
export function latestPlanReviewPlan(events: readonly WaveEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.stage !== "plan-review" || event.event !== "settled") continue;
    const plan = event.detail?.plan;
    if (typeof plan === "string" && plan !== "") return plan;
  }
  return undefined;
}

/**
 * The plan-review facts the collector gathers for one lane: when it
 * dispatched, and the row hash the wave's clear review recorded for it. A
 * review counts only when it was `settled` with verdict `clear` under the
 * reserved `_plan` lane, for this wave, and precedes the dispatch in ts — an
 * unparseable ts on either side is silence, and silence is never read as
 * reviewed. The latest qualifying review wins.
 */
export function planReviewFacts(
  events: readonly WaveEvent[],
  wave: string,
  lane: string,
): PlanReviewObservation {
  let dispatchedAt: string | undefined;
  for (const event of events) {
    if (event.wave !== wave || event.lane !== lane) continue;
    if (event.stage === "dispatch" && event.event === "started") dispatchedAt = event.ts;
  }
  if (dispatchedAt === undefined) return {};

  // An unparseable dispatch ts is silence, and silence is never read as
  // reviewed: "before" cannot be established, so no review qualifies.
  const dispatchMs = Date.parse(dispatchedAt);
  if (Number.isNaN(dispatchMs)) return { dispatchedAt };
  let reviewedHash: string | undefined;
  for (const event of events) {
    if (event.wave !== wave || event.lane !== PLAN_REVIEW_LANE) continue;
    if (event.stage !== "plan-review" || event.event !== "settled") continue;
    if (event.detail?.verdict !== "clear") continue;
    const ts = Date.parse(event.ts);
    if (Number.isNaN(ts) || ts > dispatchMs) continue;
    const hash = asHashRecord(event.detail?.rows)?.[lane];
    if (hash !== undefined) reviewedHash = hash;
  }
  return { dispatchedAt, ...(reviewedHash !== undefined ? { reviewedHash } : {}) };
}

/**
 * The plan-review gate's flag, derived and never gathered: a lane dispatched
 * on a row that had no `clear` review before the dispatch — or whose reviewed
 * hash differs from the row's hash at collection time — is "dispatched on an
 * unreviewed row". When the row cannot be re-read at all, the read failed,
 * not the review: that is "nobody looked", which is silence, the same way an
 * events-only row's missing observation is silence — never a verdict invented
 * from a read that failed.
 */
export function planReviewFlag(obs: PlanReviewObservation): string | undefined {
  if (obs.dispatchedAt === undefined) return undefined;
  if (obs.reviewedHash === undefined) return "dispatched on an unreviewed row";
  if (obs.rowHash === undefined) return undefined;
  return obs.rowHash === obs.reviewedHash ? undefined : "dispatched on an unreviewed row";
}
