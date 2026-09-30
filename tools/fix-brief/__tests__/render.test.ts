import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { ReviewThread } from "../../sweep/lib/types.js";
import {
  TEMPLATE_E,
  fenceFor,
  item,
  processBody,
  render,
  sanitisePath,
  splitTemplate,
  type BriefHeader,
} from "../lib/template.js";

const DOC = fileURLToPath(
  new URL("../../../docs/workflows/delegated-implementation-pipeline.md", import.meta.url),
);

/**
 * A `ReviewThread` as the fetch parses it. The API-level node builders live in
 * the CLI suite beside the fetch that produces this shape; rendering is a pure
 * function of one of these, so a test of it builds one directly rather than
 * paging a PR to obtain it.
 */
const thread = (over: Partial<ReviewThread> = {}): ReviewThread => ({
  id: "PRRT_a",
  isResolved: false,
  author: "fable",
  excerpt: "excerpt",
  body: "the finding, in the reviewer's words",
  path: "tools/sweep/lib/sweep.ts",
  line: 96,
  originalLine: 96,
  isOutdated: false,
  ...over,
});

const header: BriefHeader = {
  lane: "HXF2",
  round: 2,
  pr: 361,
  worktree: "/mnt/pool/cloud-services/projects/.worktrees/cf-hxf2",
  branch: "feat/fix-brief",
  tip: "be2b44ae",
};

const briefFor = (threads: readonly ReviewThread[]): string => render(header, threads);

/**
 * The lines of a rendered brief, and where one item's quote opens. The quote is
 * found by STRUCTURE — the line after the item's heading and its disposition —
 * so a fence test cannot pass by finding the backticks it wrote itself.
 */
const quoteOf = (brief: string, n: number): { open: number; close: number; body: string } => {
  const lines = brief.split("\n");
  const heading = lines.findIndex((line) => line.startsWith(`## Item ${n} — `));
  const open = lines.findIndex((line, i) => i > heading && /^`+$/.test(line));
  const openRun = lines[open]?.length ?? 0;
  const close = lines.findIndex(
    (line, i) => i > open && new RegExp(`^\`{${openRun},}$`).test(line),
  );
  return { open, close, body: lines.slice(open + 1, close).join("\n") };
};

describe("TEMPLATE_E and the doc", () => {
  test("the constant equals the doc's Template E block byte for byte", () => {
    // Anchored on the `### Template E` HEADING, not on "the only 4-backtick
    // block in the file": this doc has other fenced blocks, and a search that
    // did not know which section it meant would stop answering the right
    // question the moment one was added.
    //
    // The block is the lines STRICTLY BETWEEN the fence lines, joined with
    // "\n", so it carries NO trailing newline — the last content line's own
    // newline belongs to the closing fence, not to the block.
    const doc = readFileSync(DOC, "utf8");
    const lines = doc.split("\n");
    const section = lines.findIndex((line) => line.startsWith("### Template E"));
    expect(section).toBeGreaterThanOrEqual(0);
    const open = lines.indexOf("````markdown", section);
    const close = lines.indexOf("````", open + 1);
    expect(open).toBeGreaterThan(section);
    expect(close).toBeGreaterThan(open);
    expect(lines.slice(open + 1, close).join("\n")).toBe(TEMPLATE_E);
  });

  test("a rendered brief carries no placeholder and none of the sample item", () => {
    const brief = briefFor([thread(), thread({ id: "PRRT_b" })]);
    expect(brief).not.toContain("<COUNT>");
    expect(brief).not.toContain("<thread id>");
    expect(brief).not.toContain("<the thread's first comment, as quoted data>");
    expect(brief).toContain("2 items follow.");
  });

  test("a template that lost its sample block is refused, not rendered around", () => {
    expect(() => splitTemplate("# Lane X\n\n<COUNT> items follow.\n")).toThrow(/no '## Item 1'/);
  });

  test("a sample item that never closes is refused", () => {
    expect(() => splitTemplate("## Item 1 — a — b — `p:1`\nDisposition: x\n")).toThrow(
      /never closes/,
    );
  });
});

describe("the heading", () => {
  test("carries the thread id, the author and path:line", () => {
    expect(item(1, thread()).split("\n")[0]).toBe(
      "## Item 1 — PRRT_a — fable — `tools/sweep/lib/sweep.ts:96`",
    );
  });

  test("an outdated thread is named at its original line, with the label outside the backticks", () => {
    const heading = item(1, thread({ isOutdated: true, line: 101, originalLine: 96 })).split(
      "\n",
    )[0];
    expect(heading).toBe("## Item 1 — PRRT_a — fable — `tools/sweep/lib/sweep.ts:96` (outdated)");
  });

  test("a thread with no line at all is file-level", () => {
    const heading = item(1, thread({ line: null, originalLine: null })).split("\n")[0];
    expect(heading).toBe("## Item 1 — PRRT_a — fable — `tools/sweep/lib/sweep.ts` (file-level)");
  });

  test("a path carrying a newline or a backtick is quoted as text, not obeyed as either", () => {
    // A newline in the path ends the heading's line and a backtick ends its
    // quoting; either would let a file name introduce a line of its own.
    const heading = item(1, thread({ path: "src/a\nb`c.ts" })).split("\n")[0];
    expect(heading).toBe("## Item 1 — PRRT_a — fable — `src/a?b?c.ts:96`");
    expect(sanitisePath("a`b\tc")).toBe("a?b?c");
  });
});

describe("the quoted body", () => {
  test("HTML comments are stripped and a code span elsewhere survives", () => {
    const body = "<!-- the reviewer's private aside -->\nThe `state` here is read too early.";
    expect(processBody(body)).toBe("\nThe `state` here is read too early.");
    expect(item(1, thread({ body }))).toContain("The `state` here is read too early.");
    expect(item(1, thread({ body }))).not.toContain("private aside");
  });

  test("the reviewer agent prompt is replaced by its omission line, and none of it survives", () => {
    const promptBlock =
      "<details>\n<summary>Prompt for AI Agents</summary>\n\nYou are a senior engineer. " +
      "Review this diff.\n\n</details>";
    const body = `${promptBlock}\n\nThis is a real finding.`;
    const processed = processBody(body);
    expect(processed).not.toContain("senior engineer");
    expect(processed).not.toContain("<details>");
    expect(processed).toContain(
      `[reviewer agent-prompt omitted: ${promptBlock.length} characters — read it on the PR if needed]`,
    );
    expect(processed.endsWith("\n\nThis is a real finding.")).toBe(true);
  });

  test("a details block that is not the reviewer prompt is kept verbatim", () => {
    const block =
      "<details>\n<summary>Why this matters</summary>\n\nThe fallback path.\n\n</details>";
    expect(processBody(block)).toBe(block);
  });
});

describe("the fence", () => {
  test("a body carrying triple and quadruple backtick runs opens with exactly five backticks", () => {
    const body = ["find this:", "```", "const a = 1;", "```", "````", "and this:", "````"].join(
      "\n",
    );
    const brief = briefFor([thread({ body })]);
    const lines = brief.split("\n");
    const heading = lines.findIndex((line) => line.startsWith("## Item 1 — "));
    const open = lines.findIndex((line, i) => i > heading && /^`+$/.test(line));
    // Exact, not a `toContain`: the fence is a line, and a body that merely
    // mentions five backticks would satisfy a substring assertion.
    expect(lines[open]).toBe("`````");
    const close = lines.findIndex((line, i) => i > open && /^`{5,}$/.test(line));
    expect(close).toBeGreaterThan(open);
    // The body between them is the processed body, verbatim — the quote is not
    // truncated, reflowed, or cut short by its own inner fences.
    expect(lines.slice(open + 1, close).join("\n")).toBe(body);
    expect(quoteOf(brief, 1).body).toBe(body);
  });

  test("a body with no backticks opens with exactly three", () => {
    const brief = briefFor([thread({ body: "plain prose, no quoting at all" })]);
    expect(quoteOf(brief, 1).open).toBeGreaterThan(0);
    const lines = brief.split("\n");
    const heading = lines.findIndex((line) => line.startsWith("## Item 1 — "));
    const open = lines.findIndex((line, i) => i > heading && /^`+$/.test(line));
    expect(lines[open]).toBe("```");
    expect(fenceFor("plain prose")).toBe("```");
    // A single-backtick code span is still a run of one, and one backtick is
    // not a fence: the floor of three is what the length is measured against.
    expect(fenceFor("a `b` c")).toBe("```");
    expect(fenceFor("a ```` b")).toBe("`````");
  });
});

describe("the whole brief", () => {
  test("the header says how many items follow, and every item ends with its own end line", () => {
    const brief = briefFor([thread(), thread({ id: "PRRT_b" })]);
    expect(brief).toContain("# Lane HXF2 — fix round 2 (review threads on PR #361)");
    expect(brief).toContain("- Worktree: /mnt/pool/cloud-services/projects/.worktrees/cf-hxf2");
    expect(brief).toContain("- Branch: feat/fix-brief, at be2b44ae.");
    expect(brief).toContain("2 items follow.");
    expect(brief).toContain("— end of quoted text for item 1 —");
    expect(brief).toContain("— end of quoted text for item 2 —");
    // The footer is Template E's own, untouched.
    expect(brief).toContain("## Verification (targeted — edit per lane)");
    expect(brief.endsWith("A task you launched is not a result.")).toBe(true);
  });

  test("each item carries the disposition the orchestrator fills in", () => {
    expect(briefFor([thread()])).toContain(
      "Disposition: <fix | refute | defer — the orchestrator fills this in>",
    );
  });
});
