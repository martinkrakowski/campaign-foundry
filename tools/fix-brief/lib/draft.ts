import { fetchAllThreads } from "../../sweep/lib/sweep.js";
import type { ReviewThread } from "../../sweep/lib/types.js";
import type { FixBriefArgs } from "./args.js";
import { render } from "./template.js";

/**
 * What one draft wrote: the path it took and the thread ids that went into it,
 * so the caller can print the class for the `yarn sweep` that closes it.
 */
export interface FixBriefOutcome {
  readonly out: string;
  readonly threadIds: readonly string[];
}

/** Everything this tool touches: one read of the forge and one write of a file. */
export interface FixBriefDeps {
  readonly gh: (args: readonly string[]) => Promise<string>;
  readonly writeFile: (path: string, text: string) => Promise<void>;
  readonly exists: (path: string) => Promise<boolean>;
}

/**
 * A refusal: something about the PR, or about the file it would be written to,
 * says no. Every reason is listed at once — an operator fixing a `--threads`
 * list wants the whole list, not the first id that happened to be wrong.
 */
export class FixBriefRefusal extends Error {
  readonly reasons: readonly string[];

  constructor(message: string, reasons: readonly string[]) {
    super(message);
    this.name = "FixBriefRefusal";
    this.reasons = reasons;
  }
}

/**
 * Fetch the PR's threads, choose the ones this round carries, render the brief
 * and write it.
 *
 * The order of the refusals is the order of what has already been spent, and it
 * is deliberate:
 *
 * 1. **`--out` first, before any fetch.** Round k+1 is given its own `--out` so
 *    that round k's brief is still on disk to compare against; a run that
 *    silently overwrote it would destroy the record of what the lane was told,
 *    and a run that overwrote it after a fetch would have spent the fetch to
 *    learn nothing.
 * 2. **A partial read refuses before writing.** `fetchAllThreads` records why a
 *    page could not be read instead of treating it as empty, and a brief
 *    drafted from half a PR's threads is a brief that silently omits findings —
 *    the failure the fail-closed shape in `sweep` exists to prevent. The items
 *    already collected are discarded with it.
 * 3. **An unreadable PR refuses.** No threads and no error is not a PR with
 *    nothing to say; it is a PR this run could not see, and a brief headed
 *    "0 items follow" would be read as a clean review.
 * 4. **Every `--threads` id must be an unresolved thread of THIS PR.** A
 *    resolved one and an absent one are both refusals, named apart, because
 *    they are different mistakes — a thread already closed, or an id that is
 *    not on this PR at all.
 *
 * The write is the last thing that happens, and it is the only thing this tool
 * writes: no GitHub mutation is issued anywhere in this file. The existence
 * check above is refused *before* the fetch, and the entry wrapper opens the
 * file with `wx`, so the two together also hold when something creates it
 * between the check and the write.
 */
export async function draftBrief(plan: FixBriefArgs, deps: FixBriefDeps): Promise<FixBriefOutcome> {
  if (await deps.exists(plan.out)) {
    throw new FixBriefRefusal(`refusing to write ${plan.out} — it already exists`, [
      `${plan.out} exists, so this round would overwrite the last one; give each round its own --out`,
    ]);
  }

  const fetched = await fetchAllThreads(plan.pr, deps.gh);
  if (fetched.failures.length > 0) {
    throw new FixBriefRefusal(
      `the review threads of PR #${plan.pr} could not be read in full: ${fetched.failures.join("; ")}`,
      [...fetched.failures],
    );
  }
  if (fetched.prId === undefined) {
    throw new FixBriefRefusal(
      `refusing to draft a brief for PR #${plan.pr} — it could not be read`,
      [`PR #${plan.pr} is not readable, so its threads are unknown, not absent`],
    );
  }

  const chosen = selectThreads(plan, fetched.threads);
  // The newline is added HERE and not in `render`, so `render` still returns
  // Template E's text byte for byte — which is what the drift test compares
  // against the doc — while the file a lane reads ends with one, as every
  // other text file in a repository does.
  await deps.writeFile(plan.out, `${render(plan, chosen)}\n`);
  return { out: plan.out, threadIds: chosen.map((t) => t.id) };
}

/**
 * The threads this round carries: every unresolved one, or exactly the ones
 * `--threads` named — in FETCH order either way, so the brief's item numbers
 * follow the PR's own thread order rather than the order a shell happened to
 * spell the ids in.
 */
function selectThreads(
  plan: FixBriefArgs,
  threads: readonly ReviewThread[],
): readonly ReviewThread[] {
  const unresolved = threads.filter((t) => !t.isResolved);
  const wanted = plan.threadIds;
  if (wanted === undefined) return unresolved;
  const problems: string[] = [];
  for (const id of wanted) {
    if (unresolved.some((t) => t.id === id)) continue;
    const closed = threads.find((t) => t.id === id);
    problems.push(
      closed === undefined
        ? `${id}: not a review thread of PR #${plan.pr}`
        : `${id}: already resolved — a brief carries open threads`,
    );
  }
  if (problems.length > 0) {
    throw new FixBriefRefusal(
      `refusing to draft PR #${plan.pr} from --threads (${wanted.join(", ")}): ${problems.join("; ")}. Nothing was written.`,
      problems,
    );
  }
  return unresolved.filter((t) => wanted.includes(t.id));
}
