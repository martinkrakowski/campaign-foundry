import { describe, expect, test } from "vitest";
import { ATTRIBUTE_USAGE, parseAttributeArgs } from "../lib/args.js";
import { runCli, type SweepCliIo } from "../cli.js";

/** Longer than the 80-char excerpt, so matching the excerpt cannot succeed. */
const SUGGESTION_API =
  "Throw a proper `Error` object instead of a raw string so the error handling middleware treats it as a server error and preserves stack traces.";

const WORKFLOW = {
  UI: "PR-Agent UI Review",
  API: "PR-Agent API Review",
  Architecture: "PR-Agent Architecture Review",
} as const;

/** U+2011 NON-BREAKING HYPHEN — the character PR-Agent puts in `cache‑key`. */
const NBH = "\u2011";

function suggestionBody(text: string, label = "critical bug", importance = 4): string {
  return `**Suggestion:** ${text} [${label}, importance: ${importance}]`;
}

function threadNode(
  id: string,
  isResolved: boolean,
  author: string,
  body: string,
): Record<string, unknown> {
  return {
    id,
    isResolved,
    comments: { nodes: [{ author: { login: author }, body }] },
  };
}

function threadPage(nodes: readonly Record<string, unknown>[]): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          id: "PR_I_1",
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes,
          },
        },
      },
    },
  });
}

/**
 * A job-log line in the shape `gh run view --log` actually writes: a prefix,
 * then a JSON object whose `text` field is JSON-escaped (`\n`, `\"`).
 */
function aiLog(suggestion: string): string {
  const text =
    `\nAI response:\n\`\`\`yaml\ncode_suggestions:\n- relevant_file: |\n    apps/api/foo.ts\n  suggestion_content: |\n    ${suggestion}\n`;
  return `PR-Agent review\tUNKNOWN STEP\t2026-09-14T20:45:58.0033196Z ${JSON.stringify({ text })}`;
}

function workflowOf(args: readonly string[]): string {
  const i = args.indexOf("--workflow");
  return i >= 0 ? String(args[i + 1]) : "";
}

interface StubOpts {
  readonly nodes?: readonly Record<string, unknown>[];
  readonly threadsRaw?: string;
  readonly threadsError?: Error;
  readonly branch?: string;
  readonly branchError?: Error;
  readonly runs?: { UI?: readonly number[]; API?: readonly number[]; Architecture?: readonly number[] };
  readonly logs?: Record<number, string>;
  readonly logErrors?: Record<number, Error>;
  readonly listRaw?: Record<string, string>;
  readonly listError?: Record<string, Error>;
}

function stub(over: StubOpts = {}): {
  calls: string[][];
  gh: SweepCliIo["gh"];
} {
  const calls: string[][] = [];
  const nodes = over.nodes ?? [
    threadNode("PRRT_api", true, "github-actions", suggestionBody(SUGGESTION_API)),
  ];
  const runs = {
    UI: over.runs?.UI ?? [],
    API: over.runs?.API ?? [111],
    Architecture: over.runs?.Architecture ?? [],
  };
  const logs = over.logs ?? { 111: aiLog(SUGGESTION_API) };
  return {
    calls,
    gh: async (args: readonly string[]): Promise<string> => {
      calls.push([...args]);
      if (args[0] === "api") {
        if (over.threadsError !== undefined) throw over.threadsError;
        return over.threadsRaw ?? threadPage(nodes);
      }
      if (args[0] === "pr") {
        if (over.branchError !== undefined) throw over.branchError;
        return `${over.branch ?? "feat/example"}\n`;
      }
      if (args[0] === "run" && args[1] === "list") {
        const name = workflowOf(args);
        const listed = over.listError?.[name];
        if (listed !== undefined) throw listed;
        const raw = over.listRaw?.[name];
        if (raw !== undefined) return raw;
        const ids =
          name === WORKFLOW.UI
            ? runs.UI
            : name === WORKFLOW.API
              ? runs.API
              : name === WORKFLOW.Architecture
                ? runs.Architecture
                : [];
        return JSON.stringify(ids.map((databaseId) => ({ databaseId })));
      }
      if (args[0] === "run" && args[1] === "view") {
        const id = Number(args[2]);
        const failed = over.logErrors?.[id];
        if (failed !== undefined) throw failed;
        const log = logs[id];
        if (log === undefined) throw new Error(`unexpected run view ${String(id)}`);
        return log;
      }
      throw new Error(`unexpected gh ${args.join(" ")}`);
    },
  };
}

async function runAttribute(
  argv: readonly string[],
  gh: SweepCliIo["gh"],
): Promise<{ code: number; log: string; err: string; ghCalls: number }> {
  const log: string[] = [];
  const err: string[] = [];
  let ghCalls = 0;
  const code = await runCli({
    argv: ["attribute", ...argv],
    log: (t) => log.push(t),
    logError: (t) => err.push(t),
    readFile: async () => "",
    gh: async (args) => {
      ghCalls += 1;
      return gh(args);
    },
  });
  return { code, log: log.join("\n"), err: err.join("\n"), ghCalls };
}

describe("parseAttributeArgs", () => {
  test("the happy path: the PR whose threads will be attributed", () => {
    expect(parseAttributeArgs(["--pr", "401"])).toEqual({ pr: 401 });
  });

  test("a missing --pr is refused", () => {
    expect(() => parseAttributeArgs([])).toThrow(/--pr is required/);
  });

  test("a non-numeric --pr is refused", () => {
    expect(() => parseAttributeArgs(["--pr", "abc"])).toThrow(/wants a number/);
  });

  test("an option starved of its value is refused, with the attribute usage", () => {
    expect(() => parseAttributeArgs(["--pr"])).toThrow(/missing value for --pr/);
    expect(ATTRIBUTE_USAGE).toContain("sweep attribute");
  });

  test("an unknown argument is refused", () => {
    expect(() => parseAttributeArgs(["--pr", "401", "--yolo"])).toThrow(/unknown argument '--yolo'/);
  });
});

describe("sweep attribute — matching a thread to one workflow", () => {
  test("a thread whose suggestion text appears only in the API run's log is attributed to API", async () => {
    const s = stub();
    const { code, log } = await runAttribute(["--pr", "401"], s.gh);
    expect(code).toBe(0);
    expect(log).toContain("PRRT_api API resolved");
    expect(log).toContain("API 1 threads 1 resolved");
    expect(log).toContain("UI 0 threads 0 resolved");
    expect(log).toContain("Architecture 0 threads 0 resolved");
    expect(log).toContain("unattributed 0 threads 0 resolved");
  });

  test("text present in no log is unattributed", async () => {
    const s = stub({
      logs: { 111: aiLog("an unrelated suggestion that lives only in this log") },
    });
    const { code, log } = await runAttribute(["--pr", "401"], s.gh);
    expect(code).toBe(0);
    expect(log).toContain("PRRT_api unattributed resolved");
    expect(log).not.toContain("PRRT_api API");
    expect(log).toContain("unattributed 1 threads 1 resolved");
    expect(log).toContain("API 0 threads 0 resolved");
  });

  test("text present in two logs is unattributed, never the first match", async () => {
    const s = stub({
      runs: { UI: [10], API: [11], Architecture: [] },
      logs: { 10: aiLog(SUGGESTION_API), 11: aiLog(SUGGESTION_API) },
    });
    const { code, log } = await runAttribute(["--pr", "401"], s.gh);
    expect(code).toBe(0);
    expect(log).toContain("PRRT_api unattributed resolved");
    expect(log).not.toContain("PRRT_api UI");
    expect(log).not.toContain("PRRT_api API");
    expect(log).toContain("unattributed 1 threads 1 resolved");
    expect(log).toContain("UI 0 threads 0 resolved");
    expect(log).toContain("API 0 threads 0 resolved");
  });

  test("JSON escapes (\\n, \\\", non-breaking hyphen) in the log still match the thread's plain text", async () => {
    const suggestion = `Guard against a missing "cache${NBH}key" header instead of using the non${NBH}null assertion.`;
    const body =
      `**Suggestion:** Guard against a missing "cache${NBH}key" header\n` +
      `instead of using the non${NBH}null assertion. [possible issue, importance: 3]`;
    const logText =
      `\nAI response:\n\`\`\`yaml\ncode_suggestions:\n- suggestion_content: |\n` +
      `    Guard against a missing "cache${NBH}key" header\n` +
      `    instead of using the non${NBH}null assertion.\n`;
    const escaped = `job\tstep\tts ${JSON.stringify({ text: logText }).replaceAll(NBH, "\\u2011")}`;
    const s = stub({
      nodes: [threadNode("PRRT_esc", false, "github-actions", body)],
      logs: { 111: escaped },
    });
    const { code, log } = await runAttribute(["--pr", "401"], s.gh);
    expect(code).toBe(0);
    expect(log).toContain("PRRT_esc API open");
    expect(log).not.toContain("PRRT_esc unattributed");
    expect(suggestion).toContain('"');
    expect(suggestion).toContain(NBH);
  });

  test("a non-github-actions thread (CodeRabbit, Qodo) is not listed", async () => {
    const s = stub({
      nodes: [
        threadNode("PRRT_api", true, "github-actions[bot]", suggestionBody(SUGGESTION_API)),
        threadNode("PRRT_cr", false, "coderabbitai[bot]", suggestionBody(SUGGESTION_API)),
        threadNode("PRRT_qodo", false, "qodo-merge", suggestionBody(SUGGESTION_API)),
      ],
    });
    const { code, log } = await runAttribute(["--pr", "401"], s.gh);
    expect(code).toBe(0);
    expect(log).toContain("PRRT_api API resolved");
    expect(log).not.toContain("PRRT_cr");
    expect(log).not.toContain("PRRT_qodo");
    expect(log).toContain("API 1 threads 1 resolved");
  });
});

describe("sweep attribute — fail closed", () => {
  test("a failing log read exits 1 with the run id named", async () => {
    const s = stub({
      logErrors: { 111: new Error("gh run view: HTTP 502") },
    });
    const { code, err, log } = await runAttribute(["--pr", "401"], s.gh);
    expect(code).toBe(1);
    expect(err).toContain("111");
    expect(err).toMatch(/could not (attribute|be read)|log of run/i);
    expect(log).not.toContain("PRRT_api");
  });

  test("bad arguments exit 2 before any gh call", async () => {
    const s = stub();
    const missing = await runAttribute([], s.gh);
    expect(missing.code).toBe(2);
    expect(missing.ghCalls).toBe(0);
    expect(missing.err).toContain("--pr is required");

    const starved = await runAttribute(["--pr"], s.gh);
    expect(starved.code).toBe(2);
    expect(starved.ghCalls).toBe(0);

    const bad = await runAttribute(["--pr", "nope"], s.gh);
    expect(bad.code).toBe(2);
    expect(bad.ghCalls).toBe(0);

    const unknown = await runAttribute(["--pr", "401", "--yolo"], s.gh);
    expect(unknown.code).toBe(2);
    expect(unknown.ghCalls).toBe(0);
    expect(unknown.err).toContain("unknown argument '--yolo'");
  });

  test("a thread fetch that cannot be read exits 1, naming the failure", async () => {
    const s = stub({ threadsError: new Error("gh api graphql: HTTP 502") });
    const { code, err, log } = await runAttribute(["--pr", "401"], s.gh);
    expect(code).toBe(1);
    expect(err).toContain("HTTP 502");
    expect(err).toMatch(/could not attribute/);
    expect(log).not.toContain("PRRT_api");
  });

  test("a PR that is not readable exits 1", async () => {
    const s = stub({
      threadsRaw: JSON.stringify({ data: { repository: { pullRequest: null } } }),
    });
    const { code, err } = await runAttribute(["--pr", "401"], s.gh);
    expect(code).toBe(1);
    expect(err).toMatch(/not readable/);
  });

  test("a head branch that cannot be read exits 1", async () => {
    const s = stub({ branchError: new Error("gh pr view: HTTP 502") });
    const { code, err } = await runAttribute(["--pr", "401"], s.gh);
    expect(code).toBe(1);
    expect(err).toContain("HTTP 502");
    expect(err).toMatch(/head branch/);
  });

  test("a head branch that is empty exits 1 rather than listing runs of nothing", async () => {
    const s = stub({ branch: "" });
    const { code, err } = await runAttribute(["--pr", "401"], s.gh);
    expect(code).toBe(1);
    expect(err).toMatch(/no head branch/);
  });

  test("a run list that cannot be read exits 1, naming the workflow", async () => {
    const s = stub({
      listError: { [WORKFLOW.API]: new Error("gh run list: HTTP 502") },
    });
    const { code, err } = await runAttribute(["--pr", "401"], s.gh);
    expect(code).toBe(1);
    expect(err).toContain("HTTP 502");
    expect(err).toContain(WORKFLOW.API);
  });

  test("a run list that is not a JSON array exits 1", async () => {
    const s = stub({ listRaw: { [WORKFLOW.UI]: "{\"databaseId\":1}" } });
    const { code, err } = await runAttribute(["--pr", "401"], s.gh);
    expect(code).toBe(1);
    expect(err).toMatch(/not a JSON array|could not attribute/);
  });

  test("a run list row with no databaseId exits 1", async () => {
    const s = stub({ listRaw: { [WORKFLOW.UI]: "[{}]" } });
    const { code, err } = await runAttribute(["--pr", "401"], s.gh);
    expect(code).toBe(1);
    expect(err).toMatch(/databaseId/);
  });
});

describe("sweep attribute — bodies that cannot be matched", () => {
  test("a github-actions thread with no Suggestion marker is unattributed", async () => {
    const s = stub({
      nodes: [threadNode("PRRT_plain", false, "github-actions", "just a comment")],
    });
    const { code, log } = await runAttribute(["--pr", "401"], s.gh);
    expect(code).toBe(0);
    expect(log).toContain("PRRT_plain unattributed open");
  });

  test("a Suggestion with no trailing [label, importance: n] is unattributed", async () => {
    const s = stub({
      nodes: [threadNode("PRRT_trail", false, "github-actions", `**Suggestion:** ${SUGGESTION_API}`)],
    });
    const { code, log } = await runAttribute(["--pr", "401"], s.gh);
    expect(code).toBe(0);
    expect(log).toContain("PRRT_trail unattributed open");
  });

  test("a Suggestion whose content is blank is unattributed", async () => {
    const s = stub({
      nodes: [threadNode("PRRT_blank", true, "github-actions", "**Suggestion:**   [critical bug, importance: 4]")],
    });
    const { code, log } = await runAttribute(["--pr", "401"], s.gh);
    expect(code).toBe(0);
    expect(log).toContain("PRRT_blank unattributed resolved");
  });

  test("a log line with no JSON object still decodes escapes, so a quoted suggestion matches", async () => {
    const suggestion = `Guard against a missing "cache${NBH}key" header.`;
    const raw =
      `plain prefix suggestion_content: |\\n    Guard against a missing \\"cache\\u2011key\\" header.\\n`;
    const s = stub({
      nodes: [threadNode("PRRT_raw", false, "github-actions", suggestionBody(suggestion, "possible issue", 3))],
      logs: { 111: raw },
    });
    const { code, log } = await runAttribute(["--pr", "401"], s.gh);
    expect(code).toBe(0);
    expect(log).toContain("PRRT_raw API open");
  });
});
