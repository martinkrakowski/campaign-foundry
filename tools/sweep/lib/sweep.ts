import type { PullRequestShape, ThreadState } from "./types.js";
import { SweepRefusal } from "./types.js";

/**
 * The GraphQL fetch of the PR's threads. The short `PRVT_` ids that appear
 * in review emails and the web UI name the *discussion*; `resolveReviewThread`
 * needs the thread node id (`PRRT_`), and it fails on a wrong id with an
 * opaque `Could not resolve to…` — after a comment may already have posted.
 * So the tool verifies every id against this response before it writes, and
 * refuses if one is missing. The `id` of the pull request is fetched with
 * it because `addComment` needs the PR's node id as its subject.
 */
export const THREADS_QUERY = `query SweepThreads($number: Int!, $after: String) {
  repository(owner: "martinkrakowski", name: "campaign-foundry") {
    pullRequest(number: $number) {
      id
      reviewThreads(first: 100, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes { id isResolved }
      }
    }
  }
}`;

/**
 * The disposition itself: ONE class comment on the PR conversation
 * (`addComment`), then a `resolveReviewThread` for every member — one
 * request for the whole class. The two verbs in one mutation: a resolver
 * without the comment leaves the reply cost (F2) unchanged, and a comment
 * without the resolves is just a comment. The variables are declared by
 * the same count that `sweep` binds, so the query shape cannot drift from
 * what is sent.
 */
export function dispositionMutation(threadCount: number): string {
  const decl = Array.from({ length: threadCount }, (_, i) => `$thread${i}: ID!`).join(", ");
  const resolves = Array.from(
    { length: threadCount },
    (_, i) => `  resolve${i}: resolveReviewThread(input: { threadId: $thread${i} }) {
    thread { id isResolved }
  }`,
  ).join("\n");
  return `mutation SweepDisposition($subject: ID!, $body: String!${decl ? `, ${decl}` : ""}) {
  addComment(input: { subjectId: $subject, body: $body }) {
    comment { url }
  }
${resolves}
}`;
}

/**
 * The class body: the disposition names the mechanism once, and every id
 * it applies to is listed verbatim — so a reader of any one thread can
 * see the class it was disposed with, and a reader of the comment can see
 * what was resolved.
 */
export function classBody(disposition: string, ids: readonly string[]): string {
  const listed = ids.map((id) => `  - \`${id}\``).join("\n");
  return `${disposition.trim()}\n\nThreads disposed by this one comment (${ids.length}):\n${listed}\n`;
}

/** What one sweep does: the PR, the class ids as typed, the disposition text. */
export interface SweepPlan {
  readonly pr: number;
  readonly requested: readonly string[];
  /** Written by the human, against the code. The tool never edits it. */
  readonly disposition: string;
}

export interface SweepDeps {
  readonly gh: (args: readonly string[]) => Promise<string>;
  /** Where the preview and the outcome go — stdout for the CLI. */
  readonly out: (line: string) => void;
}

export interface SweepResult {
  readonly commentUrl: string | null;
  readonly resolvedThreadIds: readonly string[];
}

interface SweepReply extends PullRequestShape {
  readonly errors?: readonly { readonly message?: string }[];
}

/**
 * Fetch, verify, preview, then — with `post` — write.
 *
 * Two hazards, both from this week's hand sweeps, and both decided by the
 * platform's answer rather than by what the operator typed:
 *
 * 1. **Replying to the wrong thread is public and unrecoverable.** Every id
 *    is verified against the PR's real thread list before anything is
 *    written, and the exact comment plus the exact id list are printed as a
 *    preview. `post` is the sign-off on what was just shown; a preview run
 *    is the same call without the write.
 * 2. **A thread resolved without being addressed looks handled and is
 *    not.** An id that is already resolved, is a duplicate, or is not a
 *    review-thread node on this PR at all refuses the entire run, with
 *    every problem listed at once. A class that cannot be disposed as a
 *    class goes back to the operator, who re-reads the threads; the tool
 *    never guesses, and never writes half a class.
 *
 * The tool posts and resolves what it is told to. Whether the finding is
 * real is a judgement made against the code before the text is written —
 * the budget's own rules exist to keep that judgement out of the tool
 * (V-D3).
 */
export async function sweep(
  plan: SweepPlan,
  post: boolean,
  deps: SweepDeps,
): Promise<SweepResult> {
  let cursor: string | null = null;
  let prId: string | undefined;
  const fetched: ThreadState[] = [];

  do {
    const ghArgs = [
      "api",
      "graphql",
      "-f",
      `query=${THREADS_QUERY}`,
      // `-F`, not `-f`: gh sends `-f number=361` as the *string* "361", which
      // GraphQL refuses for the query's `Int!` variable — every real fetch fails
      // while a stubbed gh sails on. edges.test.ts pins the flag the call makes.
      "-F",
      `number=${plan.pr}`,
    ];
    if (cursor !== null) {
      ghArgs.push("-f", `after=${cursor}`);
    }
    const raw = await deps.gh(ghArgs);
    const reply = JSON.parse(raw) as SweepReply;
    const errorReasons = reply.errors?.map((e) => String(e.message ?? "unknown GraphQL error"));
    if (errorReasons !== undefined && errorReasons.length > 0) {
      throw new SweepRefusal(
        `the fetch of PR #${plan.pr} returned errors: ${errorReasons.join("; ")}`,
        errorReasons,
      );
    }
    const pull = reply.data?.repository?.pullRequest;
    if (pull?.id !== undefined && prId === undefined) {
      prId = pull.id;
    }
    for (const n of pull?.reviewThreads?.nodes ?? []) {
      fetched.push({
        id: String(n.id),
        isResolved: n.isResolved === true,
      });
    }
    const pageInfo = pull?.reviewThreads?.pageInfo;
    cursor = pageInfo?.hasNextPage && pageInfo.endCursor ? pageInfo.endCursor : null;
  } while (cursor !== null);

  const problems: string[] = [];
  const ids: string[] = [];
  for (const id of plan.requested) {
    if (ids.includes(id)) problems.push(`${id}: duplicate — the class is ${ids.join(", ")}`);
    else ids.push(id);
  }
  if (prId === undefined) {
    problems.push(`PR #${plan.pr} does not exist or is not readable — there is nothing to post to`);
  }
  for (const id of ids) {
    const found = fetched.find((t) => t.id === id);
    if (found === undefined) problems.push(`${id}: not a review-thread node on PR #${plan.pr}`);
    else if (found.isResolved) problems.push(`${id}: already resolved — a class member must be open`);
  }
  if (problems.length > 0) {
    throw new SweepRefusal(
      `refusing to sweep PR #${plan.pr} — class (${ids.join(", ")}): ${problems.join("; ")}. Nothing was posted.`,
      problems,
    );
  }

  const body = classBody(plan.disposition, ids);
  // Every id reaching the preview has just been verified open — the
  // guardrail above refuses the run if one is resolved or missing — so the
  // preview states that fact rather than re-checking it (which would be an
  // unreachable branch the moment the guardrail holds).
  [
    `PR #${plan.pr} — class disposition, ${ids.length} thread(s)`,
    ...ids.map((id) => `  ${id}  (open)`),
    "Comment that will be posted, verbatim:",
    "8<".padEnd(72, "-"),
    ...body.split("\n").map((line) => `| ${line}`),
    "8<".padEnd(72, "-"),
    post
      ? "--post given: writing now."
      : "preview only — re-run with --post when this is what you mean.",
  ].forEach((line) => deps.out(line));

  if (!post) return { commentUrl: null, resolvedThreadIds: [] };

  const args = ["api", "graphql", "-f", `query=${dispositionMutation(ids.length)}`];
  ids.forEach((id, i) => args.push("-f", `thread${i}=${id}`));
  args.push("-f", `subject=${prId}`, "-f", `body=${body}`);
  const written = JSON.parse(await deps.gh(args)) as {
    readonly data?: Record<string, unknown>;
    readonly errors?: readonly { readonly message?: string }[];
  };
  const writeErrors = written.errors?.map((e) => String(e.message ?? "unknown GraphQL error"));
  if (writeErrors !== undefined && writeErrors.length > 0) {
    throw new SweepRefusal(
      `the mutation on PR #${plan.pr} returned errors: ${writeErrors.join("; ")}`,
      writeErrors,
    );
  }
  const data = written.data ?? {};
  const comment = (data["addComment"] as { comment?: { url?: string } } | undefined)?.comment;
  const resolvedIds = ids.filter((_, i) => {
    const r = data[`resolve${i}`] as { thread?: { isResolved?: boolean } } | undefined;
    return r?.thread?.isResolved === true;
  });
  return { commentUrl: comment?.url ?? null, resolvedThreadIds: resolvedIds };
}
