import { describe, expect, test } from "vitest";
import { runCli, type FixBriefCliIo } from "../cli.js";

/**
 * A review-thread node as the API returns it, with the first comment and the
 * four anchor fields `fix-brief` reads — `path`, `line`, `originalLine` and
 * `isOutdated`. Copied from `tools/sweep/__tests__/gate.test.ts` rather than
 * imported, with the anchors added: a fixture written before the query carried
 * them is a different shape, and the sweep suites already cover that one.
 */
const node = (
  id: string,
  isResolved: boolean,
  over: {
    readonly author?: string;
    readonly body?: string;
    readonly path?: string;
    readonly line?: number | null;
    readonly originalLine?: number | null;
    readonly isOutdated?: boolean;
  } = {},
): Record<string, unknown> => ({
  id,
  isResolved,
  path: over.path ?? "src/sweep.ts",
  line: over.line === undefined ? 12 : over.line,
  originalLine: over.originalLine === undefined ? 12 : over.originalLine,
  isOutdated: over.isOutdated === true,
  comments: {
    nodes: [
      {
        ...(over.author === undefined ? {} : { author: { login: over.author } }),
        body: over.body ?? `finding on ${id}`,
      },
    ],
  },
});

/**
 * A page whose `pageInfo` is written out by the caller, so a malformed one can
 * be sent: the well-formed `page` below is the only shape a healthy answer
 * takes, and the defects live in the answers that are not.
 */
const pageWith = (
  nodes: readonly Record<string, unknown>[],
  info?: Record<string, unknown>,
): string =>
  JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          id: "PR_I_1",
          reviewThreads: {
            ...(info === undefined ? {} : { pageInfo: info }),
            nodes,
          },
        },
      },
    },
  });

const page = (nodes: readonly Record<string, unknown>[], next?: string): string =>
  pageWith(nodes, { hasNextPage: next !== undefined, endCursor: next ?? null });

/** The threads every test starts from, unless it says otherwise. */
const OPEN_A = node("PRRT_a", false, { author: "fable", body: "finding A", line: 10 });
const OPEN_B = node("PRRT_b", false, { author: "grok", body: "finding B", line: 20 });
const CLOSED = node("PRRT_c", true, { author: "fable", body: "an old finding", line: 30 });

const ARGV = [
  "--pr",
  "361",
  "--lane",
  "HXF2",
  "--round",
  "2",
  "--worktree",
  "/mnt/pool/cloud-services/projects/.worktrees/cf-hxf2",
  "--branch",
  "feat/fix-brief",
  "--tip",
  "be2b44ae",
  "--out",
  ".agents/briefs/scratch/HXF2-r2.md",
];

interface Written {
  readonly path: string;
  readonly text: string;
}

interface Harness {
  readonly io: FixBriefCliIo;
  readonly log: string[];
  readonly err: string[];
  readonly written: Written[];
  readonly calls: string[][];
}

/**
 * The whole CLI with its I/O injected: `gh` answers the threads query by
 * cursor, `exists` and `writeFile` are the file side, and every call is
 * recorded so a test can prove the tool wrote once and read only. `argv` and
 * `pages` are the two knobs, and neither reaches the io object — an `argv`
 * that replaced the command line instead of extending it is the mistake this
 * helper exists to make impossible.
 */
const harness = (
  over: Partial<FixBriefCliIo> & { readonly pages?: (cursor: string) => string } = {},
): Harness => {
  const log: string[] = [];
  const err: string[] = [];
  const written: Written[] = [];
  const calls: string[][] = [];
  const { pages: pagesKnob, argv: extraArgv, ...io } = over;
  const pages = pagesKnob ?? (() => page([OPEN_A, OPEN_B, CLOSED]));
  return {
    io: {
      argv: [...ARGV, ...(extraArgv ?? [])],
      log: (text) => log.push(text),
      logError: (text) => err.push(text),
      gh: async (args: readonly string[]): Promise<string> => {
        calls.push([...args]);
        const after = args.find((a) => a.startsWith("after="));
        return pages(after === undefined ? "" : after.slice("after=".length));
      },
      writeFile: async (path, text) => {
        written.push({ path, text });
      },
      exists: async () => false,
      ...io,
    },
    log,
    err,
    written,
    calls,
  };
};

describe("runCli — drafting", () => {
  test("every unresolved thread becomes an item, in fetch order, and one file is written", async () => {
    const { io, written, log, calls } = harness();
    expect(await runCli(io)).toBe(0);
    expect(written).toHaveLength(1);
    expect(written[0]?.path).toBe(".agents/briefs/scratch/HXF2-r2.md");
    const brief = written[0]?.text ?? "";
    expect(brief).toContain("2 items follow.");
    expect(brief.indexOf("## Item 1 — PRRT_a")).toBeLessThan(brief.indexOf("## Item 2 — PRRT_b"));
    expect(brief).toContain("`src/sweep.ts:10`");
    expect(log.join("\n")).toContain("wrote .agents/briefs/scratch/HXF2-r2.md — 2 item(s)");
    // Read-only on the forge: every call is the threads query.
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.some((a) => a.includes("query SweepThreads"))).toBe(true);
  });

  test("a resolved thread is excluded", async () => {
    const { io, written } = harness();
    expect(await runCli(io)).toBe(0);
    const brief = written[0]?.text ?? "";
    expect(brief).not.toContain("PRRT_c");
    expect(brief).not.toContain("an old finding");
  });

  test("--threads filters to the named ids, still in fetch order", async () => {
    const { io, written } = harness({ argv: ["--threads", "PRRT_b,PRRT_a"] });
    expect(await runCli(io)).toBe(0);
    const brief = written[0]?.text ?? "";
    expect(brief).toContain("2 items follow.");
    expect(brief.indexOf("## Item 1 — PRRT_a")).toBeLessThan(brief.indexOf("## Item 2 — PRRT_b"));
    expect(brief).not.toContain("PRRT_c");
  });

  test("--threads naming one id drafts one item", async () => {
    const { io, written } = harness({ argv: ["--threads", "PRRT_b"] });
    expect(await runCli(io)).toBe(0);
    expect(written[0]?.text).toContain("1 items follow.");
    expect(written[0]?.text).toContain("## Item 1 — PRRT_b");
  });

  test("a two-page PR yields every thread", async () => {
    const { io, written } = harness({
      pages: (cursor) => (cursor === "" ? page([OPEN_A], "CURSOR_2") : page([OPEN_B, CLOSED])),
    });
    expect(await runCli(io)).toBe(0);
    const brief = written[0]?.text ?? "";
    expect(brief).toContain("PRRT_a");
    expect(brief).toContain("PRRT_b");
    expect(brief).not.toContain("PRRT_c");
  });
});

describe("runCli — refusals", () => {
  test("an id that is not a thread of the PR exits 1, names it, and writes nothing", async () => {
    const { io, written, err } = harness({ argv: ["--threads", "PRRT_zz"] });
    expect(await runCli(io)).toBe(1);
    expect(written).toHaveLength(0);
    expect(err.join("\n")).toContain("PRRT_zz: not a review thread of PR #361");
  });

  test("a resolved id in --threads exits 1, saying it is already resolved", async () => {
    const { io, written, err } = harness({ argv: ["--threads", "PRRT_c"] });
    expect(await runCli(io)).toBe(1);
    expect(written).toHaveLength(0);
    expect(err.join("\n")).toContain("PRRT_c: already resolved");
  });

  test("a duplicated id exits 2 before any forge call", async () => {
    const { io, written, err, calls } = harness({ argv: ["--threads", "PRRT_a,PRRT_a"] });
    expect(await runCli(io)).toBe(2);
    expect(calls).toHaveLength(0);
    expect(written).toHaveLength(0);
    expect(err.join("\n")).toContain("PRRT_a is listed twice");
  });

  test("a wrong command line exits 2 before any forge call", async () => {
    const { io, written, err, calls } = harness({ argv: ["--thread", "PRRT_a"] });
    expect(await runCli(io)).toBe(2);
    expect(calls).toHaveLength(0);
    expect(written).toHaveLength(0);
    expect(err.join("\n")).toContain("unknown argument");
  });

  test("a partial read exits 1 with nothing written", async () => {
    const { io, written, err } = harness({
      pages: () => JSON.stringify({ errors: [{ message: "the connection died" }] }),
    });
    expect(await runCli(io)).toBe(1);
    expect(written).toHaveLength(0);
    expect(err.join("\n")).toContain("the connection died");
  });

  test("an existing --out exits 1, leaves the file alone, and never asks the forge", async () => {
    const { io, written, err, calls } = harness({ exists: async () => true });
    expect(await runCli(io)).toBe(1);
    expect(calls).toHaveLength(0);
    expect(written).toHaveLength(0);
    expect(err.join("\n")).toContain("already exists");
  });

  test("a PR that cannot be read exits 1 rather than drafting a brief of no items", async () => {
    const { io, written, err } = harness({ pages: () => JSON.stringify({ data: {} }) });
    expect(await runCli(io)).toBe(1);
    expect(written).toHaveLength(0);
    expect(err.join("\n")).toContain("is not readable");
  });

  test("a write that fails exits 1 and says so", async () => {
    const { io, err } = harness({
      writeFile: async () => {
        throw new Error("EACCES: read-only file system");
      },
    });
    expect(await runCli(io)).toBe(1);
    expect(err.join("\n")).toContain("EACCES: read-only file system");
  });

  test("the written brief ends with a newline, as every other text file here does", async () => {
    const { io, written } = harness();
    expect(await runCli(io)).toBe(0);
    // Added at the write and NOT in `render`, which still returns Template E's
    // text byte for byte — that is what the drift test compares against the doc.
    expect(written[0]?.text.endsWith("A task you launched is not a result.\n")).toBe(true);
  });

  test("a PR with nothing unresolved says so, and still writes the brief it was asked for", async () => {
    const { io, written, log } = harness({ pages: () => page([CLOSED]) });
    expect(await runCli(io)).toBe(0);
    expect(written[0]?.text).toContain("0 items follow.");
    expect(log.join("\n")).toContain("nothing is unresolved on that PR");
  });
});
