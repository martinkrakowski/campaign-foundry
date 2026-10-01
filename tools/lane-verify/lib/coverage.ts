/**
 * `coverage/coverage-summary.json`, and the one question asked of it.
 *
 * The file is read rather than the coverage TEXT table because the text table is
 * the wrong instrument for this job twice over. Under an agent it HIDES the
 * fully covered files, so "nothing below 100" and "nothing was measured" print
 * the same empty section; and its rendering is for a person at a terminal, not
 * for a tool that has to put a verdict in an exit code.
 */

/** Where vitest's `json-summary` reporter writes, relative to the worktree. */
export const COVERAGE_SUMMARY = "coverage/coverage-summary.json";

/**
 * The four metrics `istanbul` reports per file, and the four this tool reads.
 *
 * All four, and the brief's rule is that a file is under 100 if ANY of them is.
 * Branches is the one that earns its place: it is the only metric that can be
 * below 100 while every line of the file was executed — an `||` whose right
 * operand never ran, a guard written so that one side is unreachable — so a check
 * that read lines, functions and statements would report a file as fully covered
 * that has a branch nobody has ever reached.
 */
const METRICS = ["lines", "branches", "functions", "statements"] as const;

/** The `pct` of one metric bucket, or `undefined` when the bucket is absent. */
function pctOf(entry: unknown, metric: string): unknown {
  const bucket = (entry as { readonly [key: string]: unknown } | null | undefined)?.[metric];
  return (bucket as { readonly pct?: unknown } | null | undefined)?.pct;
}

/**
 * Every file in the summary that is under 100 in any of the four metrics, one
 * line each, as `<file>  <the metrics that are under>`.
 *
 * The comparison is `!== 100` and not `< 100` on purpose. `pct` is `100` for a
 * fully covered file and the string `"Unknown"` for one istanbul could not
 * measure at all — a bucket with no statements, or a file it could not
 * instrument. `"Unknown"` is emphatically not 100, and treating it as anything
 * else would let an unmeasurable file pass a gate whose whole claim is that it
 * was measured. The same expression covers a bucket that is missing outright.
 *
 * The `total` key is skipped: it is the repository's aggregate, not a file, and
 * reporting it would list every metric in the run the moment any file was short.
 */
export function underHundred(summaryText: string): readonly string[] {
  const parsed: unknown = JSON.parse(summaryText);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("the summary is not a JSON object of files");
  }
  const short: string[] = [];
  for (const [file, entry] of Object.entries(parsed)) {
    if (file === "total") continue;
    const metrics = METRICS.filter((metric) => pctOf(entry, metric) !== 100);
    if (metrics.length > 0) short.push(`${file}  ${metrics.join(" ")}`);
  }
  return short;
}
