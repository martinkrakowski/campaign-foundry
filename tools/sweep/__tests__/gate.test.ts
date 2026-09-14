import { describe, expect, test } from "vitest";
import { mergeGate, type MergeGateDecision, type MergeGatePlan } from "../lib/gate.js";

const HEAD = "abc1234";
const plan: MergeGatePlan = { pr: 361, head: HEAD };

const reasonsOf = (decision: MergeGateDecision): readonly string[] =>
  decision.kind === "refuse" ? decision.reasons : [];

/** A review-thread node as the API returns it, with the first comment the gate names it by. */
const node = (
  id: string,
  isResolved: boolean,
  over: { readonly author?: string; readonly body?: string } = {},
): Record<string, unknown> => ({
  id,
  isResolved,
  comments: {
    nodes: [
      {
        ...(over.author === undefined ? {} : { author: { login: over.author } }),
        body: over.body ?? "",
      },
    ],
  },
});

const page = (nodes: readonly Record<string, unknown>[], next?: string): string =>
  JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          id: "PR_I_1",
          reviewThreads: {
            pageInfo: { hasNextPage: next !== undefined, endCursor: next ?? null },
            nodes,
          },
        },
      },
    },
  });

/**
 * Answers the threads query by cursor and `gh pr view` by `head`.
 *
 * `pages` is a function of the cursor rather than a list so that a test reading
 * a page it did not declare fails loudly instead of being answered "{}" — a
 * stub that invents pages is how a pagination bug survives its own test.
 */
const stub = (
  pages: (cursor: string) => string,
  head: string | Error = HEAD,
): { calls: string[][]; gh: (args: readonly string[]) => Promise<string> } => {
  const calls: string[][] = [];
  return {
    calls,
    gh: async (args: readonly string[]): Promise<string> => {
      calls.push([...args]);
      if (args[0] === "pr") {
        if (head instanceof Error) throw head;
        return `${head}\n`;
      }
      const after = args.find((a) => a.startsWith("after="));
      return pages(after === undefined ? "" : after.slice("after=".length));
    },
  };
};

describe("mergeGate — unresolved threads", () => {
  test("zero unresolved across two pages allows the merge, and both pages are read", async () => {
    const s = stub((cursor) =>
      cursor === ""
        ? page([node("PRRT_a", true), node("PRRT_b", true)], "c1")
        : page([node("PRRT_c", true)]),
    );
    const decision = await mergeGate(plan, { gh: s.gh });
    expect(decision.kind).toBe("merge");
    const reads = s.calls.filter((c) => c[0] === "api");
    expect(reads).toHaveLength(2);
    expect(reads[1]).toContain("after=c1");
    expect(s.calls.some((c) => c[0] === "pr")).toBe(true);
  });

  test("one unresolved thread on the second page is refused and named", async () => {
    const s = stub((cursor) =>
      cursor === ""
        ? page([node("PRRT_a", true)], "c1")
        : page([
            node("PRRT_b", false, {
              author: "qodo-merge",
              body: "this dereferences an undefined duration",
            }),
          ]),
    );
    const decision = await mergeGate(plan, { gh: s.gh });
    expect(decision.kind).toBe("refuse");
    const joined = reasonsOf(decision).join("\n");
    expect(joined).toContain("PRRT_b");
    expect(joined).toContain("qodo-merge");
    expect(joined).toContain("dereferences an undefined duration");
    // Threads are the cheaper answer: once one is open there is nothing a
    // head read could add, so the gate does not ask.
    expect(s.calls.some((c) => c[0] === "pr")).toBe(false);
  });

  test("a long first comment is excerpted, and a thread with no author still names the thread", async () => {
    const long = "x".repeat(200);
    const s = stub(() => page([node("PRRT_z", false, { body: long })]));
    const decision = await mergeGate(plan, { gh: s.gh });
    const joined = reasonsOf(decision).join("\n");
    expect(joined).toContain("unknown");
    expect(joined).toContain(`"${"x".repeat(80)}…"`);
  });
});

describe("mergeGate — a page that cannot be read is undecidable, never empty", () => {
  test("a GraphQL error on the second page refuses as could-not-decide", async () => {
    const s = stub((cursor) =>
      cursor === ""
        ? page([node("PRRT_a", true)], "c1")
        : JSON.stringify({ errors: [{ message: "Could not resolve to a PullRequest" }] }),
    );
    const decision = await mergeGate(plan, { gh: s.gh });
    expect(decision.kind).toBe("refuse");
    const joined = reasonsOf(decision).join("\n");
    expect(joined).toContain("could not decide");
    expect(joined).toContain("Could not resolve to a PullRequest");
  });

  test("a page whose gh call throws refuses as could-not-decide", async () => {
    const s = stub((cursor) => {
      if (cursor === "") return page([node("PRRT_a", true)], "c1");
      throw new Error("gh api graphql: HTTP 502");
    });
    const decision = await mergeGate(plan, { gh: s.gh });
    expect(decision.kind).toBe("refuse");
    const joined = reasonsOf(decision).join("\n");
    expect(joined).toContain("could not decide");
    expect(joined).toContain("HTTP 502");
  });

  test("a PR that is not readable refuses as could-not-decide", async () => {
    const s = stub(() => JSON.stringify({ data: { repository: { pullRequest: null } } }));
    const decision = await mergeGate(plan, { gh: s.gh });
    expect(decision.kind).toBe("refuse");
    expect(reasonsOf(decision).join("\n")).toContain("could not decide");
  });
});

describe("mergeGate — the head the checks were verified on", () => {
  test("a head that moved is refused, naming both SHAs", async () => {
    const s = stub(() => page([node("PRRT_a", true)]), "deadbeef");
    const decision = await mergeGate(plan, { gh: s.gh });
    expect(decision.kind).toBe("refuse");
    const joined = reasonsOf(decision).join("\n");
    expect(joined).toContain(HEAD);
    expect(joined).toContain("deadbeef");
    expect(joined).toMatch(/head moved/);
  });

  test("a head that could not be read refuses as could-not-decide", async () => {
    const s = stub(() => page([node("PRRT_a", true)]), new Error("gh pr view: HTTP 502"));
    const decision = await mergeGate(plan, { gh: s.gh });
    expect(decision.kind).toBe("refuse");
    const joined = reasonsOf(decision).join("\n");
    expect(joined).toContain("could not decide");
    expect(joined).toContain("HTTP 502");
  });

  test("a head answer that is empty refuses rather than matching", async () => {
    const s = stub(() => page([node("PRRT_a", true)]), "");
    const decision = await mergeGate(plan, { gh: s.gh });
    expect(decision.kind).toBe("refuse");
    expect(reasonsOf(decision).join("\n")).toMatch(/no head/);
  });
});
