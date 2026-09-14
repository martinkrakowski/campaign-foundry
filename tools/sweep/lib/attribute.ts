import { errorText, fetchAllThreads } from "./sweep.js";
import type { AttributeArgs } from "./args.js";

/**
 * The three PR-Agent workflow *names* as GitHub Actions records them. All
 * three post as `github-actions[bot]` with no marker in the comment, so the
 * name on the check run — not the thread — is what splits them.
 */
export const PR_AGENT_WORKFLOWS = [
  { name: "PR-Agent UI Review", key: "UI" },
  { name: "PR-Agent API Review", key: "API" },
  { name: "PR-Agent Architecture Review", key: "Architecture" },
] as const;

export type WorkflowKey = (typeof PR_AGENT_WORKFLOWS)[number]["key"];
export type Attribution = WorkflowKey | "unattributed";

export type AttributeDecision =
  | { readonly kind: "ok"; readonly lines: readonly string[] }
  | { readonly kind: "fail"; readonly reasons: readonly string[] };

export interface AttributeDeps {
  readonly gh: (args: readonly string[]) => Promise<string>;
}

const SUGGESTION_TRAIL = /\s*\[([^,\]]+),\s*importance:\s*\d+\]\s*$/;

export function normaliseWs(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The text between `**Suggestion:**` and the trailing `[label, importance: n]`,
 * whitespace-normalised. Null when the first comment is not that shape — a
 * body we cannot match is unattributed, never a guess at nearby prose.
 */
export function suggestionOf(body: string): string | null {
  const marker = "**Suggestion:**";
  const at = body.indexOf(marker);
  if (at < 0) return null;
  const rest = body.slice(at + marker.length);
  const trail = rest.match(SUGGESTION_TRAIL);
  if (trail === null) return null;
  const normalised = normaliseWs(rest.slice(0, trail.index));
  return normalised === "" ? null : normalised;
}

/**
 * JSON-escaped log text (`\n`, `\"`, `\u2011`) as the model wrote it. The
 * match is against this decoded form, because the thread body is plain text
 * and the job log is the JSON-escaped `{"text": "..."}` line `gh run view
 * --log` prints.
 */
export function decodeRunLog(raw: string): string {
  return unescapeJsonEscapes(raw);
}

function unescapeJsonEscapes(raw: string): string {
  return raw
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function isPrAgentAuthor(login: string): boolean {
  return login.replace(/\[bot\]$/, "") === "github-actions";
}

function runIdsFromList(stdout: string, workflow: string): number[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) {
    throw new Error(`run list for ${workflow} was not a JSON array`);
  }
  const ids: number[] = [];
  for (const row of parsed) {
    const id = (row as { databaseId?: unknown }).databaseId;
    if (typeof id !== "number") {
      throw new Error(`run list for ${workflow} carried a row with no databaseId`);
    }
    ids.push(id);
  }
  return ids;
}

/**
 * Attribute each `github-actions` review thread to the PR-Agent workflow
 * whose decoded job log contains that thread's suggestion text.
 *
 * Exactly one matching workflow → that workflow; none or several →
 * `unattributed`. A partial read (threads or a log) is a failure, not a
 * split of what happened to come back — same fail-closed rule as `gate`.
 */
export async function attribute(plan: AttributeArgs, deps: AttributeDeps): Promise<AttributeDecision> {
  const fetched = await fetchAllThreads(plan.pr, deps.gh);
  if (fetched.failures.length > 0) {
    return {
      kind: "fail",
      reasons: [
        `could not attribute — the review threads of PR #${plan.pr} could not be read: ${fetched.failures.join("; ")}`,
      ],
    };
  }
  if (fetched.prId === undefined) {
    return {
      kind: "fail",
      reasons: [`could not attribute — PR #${plan.pr} is not readable, so its threads are unknown`],
    };
  }

  let branch: string;
  try {
    branch = (
      await deps.gh(["pr", "view", String(plan.pr), "--json", "headRefName", "--jq", ".headRefName"])
    ).trim();
  } catch (error) {
    return {
      kind: "fail",
      reasons: [
        `could not attribute — the head branch of PR #${plan.pr} could not be read: ${errorText(error)}`,
      ],
    };
  }
  if (branch === "") {
    return {
      kind: "fail",
      reasons: [`could not attribute — PR #${plan.pr} reported no head branch`],
    };
  }

  const decodedByWorkflow: { key: WorkflowKey; decoded: string }[] = [];
  for (const wf of PR_AGENT_WORKFLOWS) {
    let ids: number[];
    try {
      const listed = await deps.gh([
        "run",
        "list",
        "--branch",
        branch,
        "--workflow",
        wf.name,
        "--json",
        "databaseId",
        "--limit",
        "50",
      ]);
      ids = runIdsFromList(listed, wf.name);
    } catch (error) {
      return {
        kind: "fail",
        reasons: [
          `could not attribute — runs of ${wf.name} on ${branch} could not be listed: ${errorText(error)}`,
        ],
      };
    }
    const parts: string[] = [];
    for (const id of ids) {
      let raw: string;
      try {
        raw = await deps.gh(["run", "view", String(id), "--log"]);
      } catch (error) {
        return {
          kind: "fail",
          reasons: [`could not attribute — log of run ${id} could not be read: ${errorText(error)}`],
        };
      }
      parts.push(decodeRunLog(raw));
    }
    decodedByWorkflow.push({ key: wf.key, decoded: parts.join("\n") });
  }

  const counts: Record<Attribution, { threads: number; resolved: number }> = {
    UI: { threads: 0, resolved: 0 },
    API: { threads: 0, resolved: 0 },
    Architecture: { threads: 0, resolved: 0 },
    unattributed: { threads: 0, resolved: 0 },
  };
  const lines: string[] = [];
  for (const thread of fetched.threads) {
    if (!isPrAgentAuthor(thread.author)) continue;
    const suggestion = suggestionOf(thread.body);
    const matched: WorkflowKey[] = [];
    if (suggestion !== null) {
      for (const wf of decodedByWorkflow) {
        if (normaliseWs(wf.decoded).includes(suggestion)) matched.push(wf.key);
      }
    }
    const workflow: Attribution = matched.length === 1 ? matched[0] : "unattributed";
    const state = thread.isResolved ? "resolved" : "open";
    lines.push(`${thread.id} ${workflow} ${state}`);
    const bucket = counts[workflow];
    bucket.threads += 1;
    if (thread.isResolved) bucket.resolved += 1;
  }

  lines.push("");
  for (const key of ["UI", "API", "Architecture", "unattributed"] as const) {
    const c = counts[key];
    lines.push(`${key} ${c.threads} threads ${c.resolved} resolved`);
  }
  return { kind: "ok", lines };
}
