import type { Premise, PremiseResult, VerifyDeps } from "./types.js";

export const EXIT_ALL_HOLD = 0;
export const EXIT_STALE_FOUND = 1;

export async function verifyPremises(
  premises: readonly Premise[],
  deps: VerifyDeps,
): Promise<readonly PremiseResult[]> {
  const results: PremiseResult[] = [];
  for (const premise of premises) {
    const { exitCode, output } = await deps.execute(premise.script);
    results.push({
      premise,
      status: exitCode === 0 ? "holds" : "stale",
      exitCode,
      output,
    });
  }
  return results;
}

/**
 * The stale lines come first and say what to do, because the whole point is
 * that a stale premise is read before a lane is dispatched against it.
 */
export function formatReport(results: readonly PremiseResult[]): string {
  const stale = results.filter((r) => r.status === "stale");
  const lines: string[] = [];
  for (const r of stale) {
    lines.push(
      `STALE  ${r.premise.lane}  (${r.premise.plan})`,
      `  the premise exited ${r.exitCode}: the gap this lane describes is already closed.`,
      `  Do not dispatch it. Re-read the code, then amend or withdraw the lane.`,
    );
    if (r.output !== "") lines.push(`  ${r.output.split("\n").join("\n  ")}`);
  }
  const held = results.length - stale.length;
  lines.push(
    stale.length === 0
      ? `${held} premise(s) hold; no lane is stale.`
      : `${stale.length} stale, ${held} holding.`,
  );
  return lines.join("\n");
}

export function exitCodeFor(results: readonly PremiseResult[]): number {
  return results.some((r) => r.status === "stale") ? EXIT_STALE_FOUND : EXIT_ALL_HOLD;
}
