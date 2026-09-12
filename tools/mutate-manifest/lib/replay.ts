import { runMutation } from "../../mutate/lib/mutate.js";
import type { MutationDeps } from "../../mutate/lib/types.js";
import type { Manifest, MutationCheck } from "./types.js";

export const EXIT_VERIFIED = 0;
export const EXIT_MISMATCH = 1;

/** Somewhere to put the literal texts so `runMutation` can read them the way it always does. */
export interface ScratchDeps {
  /** Creates a directory and returns its path. */
  readonly makeDir: () => Promise<string>;
  /** Writes `text` to `path`. */
  readonly writeText: (path: string, text: string) => Promise<void>;
  /** Removes the directory and everything in it. Called even when a mutation throws. */
  readonly removeDir: (path: string) => Promise<void>;
  /** Joins path segments. Injected so the tests need no filesystem at all. */
  readonly join: (...parts: readonly string[]) => string;
}

/**
 * Re-runs every mutation a manifest claims, and reports what actually happened.
 *
 * The literal texts are written to a scratch directory and handed to
 * `runMutation` as paths, so the engine that produced the original verdict is
 * the engine that checks it. A second implementation of "apply this mutation"
 * would be free to drift from the first, and the drift would look like
 * agreement.
 */
export async function replayManifest(
  manifest: Manifest,
  deps: MutationDeps,
  scratch: ScratchDeps,
): Promise<readonly MutationCheck[]> {
  const dir = await scratch.makeDir();
  try {
    const checks: MutationCheck[] = [];
    for (const [index, mutation] of manifest.mutations.entries()) {
      const beforePath = scratch.join(dir, `${index}.before`);
      const afterPath = scratch.join(dir, `${index}.after`);
      await scratch.writeText(beforePath, mutation.before);
      await scratch.writeText(afterPath, mutation.after);
      const result = await runMutation(
        {
          file: mutation.file,
          before: beforePath,
          after: afterPath,
          because: mutation.because,
          command: mutation.command,
        },
        deps,
      );
      checks.push({
        mutation,
        status: result.verdict === mutation.verdict ? "verified" : "mismatch",
        observed: result.verdict,
      });
    }
    return checks;
  } finally {
    await scratch.removeDir(dir);
  }
}

export function formatChecks(lane: string, checks: readonly MutationCheck[]): string {
  const lines: string[] = [];
  for (const check of checks) {
    if (check.status === "mismatch") {
      lines.push(
        `MISMATCH  ${check.mutation.file}`,
        `  claimed: ${check.mutation.verdict}    observed: ${check.observed}`,
        `  because: ${check.mutation.because}`,
        `  The lane reported a mutation its tests do not catch, so the test does`,
        `  not pin what the manifest says it pins.`,
      );
    }
  }
  const bad = checks.filter((c) => c.status === "mismatch").length;
  lines.push(
    bad === 0
      ? `${lane}: ${checks.length} mutation(s) re-run, every verdict reproduced.`
      : `${lane}: ${bad} of ${checks.length} mutation(s) did not reproduce.`,
  );
  return lines.join("\n");
}

export function exitCodeFor(checks: readonly MutationCheck[]): number {
  return checks.some((c) => c.status === "mismatch") ? EXIT_MISMATCH : EXIT_VERIFIED;
}
