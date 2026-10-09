import { describe, expect, test } from "vitest";
import { render, type RenderResult } from "../lib/render.js";
import type { CollectedBlock } from "../lib/collect.js";

function makeBlock(overrides: Partial<CollectedBlock> = {}): CollectedBlock {
  return {
    tier: 1,
    path: "packages/repo/foo.ts",
    startLine: 10,
    endLine: 15,
    symbol: "fooFn",
    why: "test block",
    text: "function fooFn() { return 42; }",
    ...overrides,
  };
}

describe("render", () => {
  test("the header is verbatim with the base commit and counts", () => {
    const result = render("abc1234", [makeBlock()], 15000);
    expect(result.text).toContain("# Reference code from the base commit abc1234");
    expect(result.text).toContain(
      "# This is NOT part of the change under review. It is unchanged code the change depends on,",
    );
    expect(result.text).toContain(
      "# read from the base commit. A finding whose fix lies in this file is not posted.",
    );
    expect(result.text).toContain("# 1 block(s), 0 dropped for budget");
  });

  test("a block is rendered with ##, why, and a fenced code block", () => {
    const block = makeBlock({ text: "const x = 1;" });
    const result = render("abc1234", [block], 15000);
    expect(result.text).toContain("## packages/repo/foo.ts:10-15 fooFn");
    expect(result.text).toContain("why: test block");
    expect(result.text).toContain("```\nconst x = 1;\n```");
    expect(result.blocksWritten).toBe(1);
    expect(result.blocksDropped).toBe(0);
  });

  test("the fence is longer than any backtick run in the text", () => {
    const block = makeBlock({ text: "code with ``` inline ``` backticks" });
    const result = render("base", [block], 15000);
    expect(result.text).toContain("````");
  });

  test("blocks stop at the token budget and the header counts the dropped ones", () => {
    const small = makeBlock({ text: "x" });
    const big = makeBlock({ text: "y".repeat(400) });
    const smallTokens = render("base", [small], 999999).totalTokens;
    const result = render("base", [small, big], smallTokens);
    expect(result.blocksWritten).toBe(1);
    expect(result.blocksDropped).toBe(1);
    expect(result.text).toContain("1 block(s), 1 dropped for budget");
  });

  test("zero max-tokens drops every block", () => {
    const result = render("base", [makeBlock()], 0);
    expect(result.blocksWritten).toBe(0);
    expect(result.blocksDropped).toBe(1);
  });

  test("zero blocks produces a header with zero counts", () => {
    const result = render("base", [], 15000);
    expect(result.blocksWritten).toBe(0);
    expect(result.blocksDropped).toBe(0);
    expect(result.text).toContain("0 block(s), 0 dropped for budget");
  });

  test("the same inputs give a byte-identical text", () => {
    const blocks = [makeBlock(), makeBlock({ text: "second block" })];
    const a = render("base", blocks, 15000);
    const b = render("base", blocks, 15000);
    expect(a.text).toBe(b.text);
  });
});

describe("tier share and trimming", () => {
  test("one tier cannot take more than half the budget while another tier still has a block that fits", () => {
    const base = "base";
    const headerTokens = render(base, [], 999999).totalTokens;
    const oneBlock = render(base, [makeBlock({ tier: 1, text: "x".repeat(100) })], 999999);
    const blockTokens = oneBlock.totalTokens - headerTokens;
    const maxTokens = headerTokens + 3 * blockTokens;
    const result = render(
      base,
      [
        makeBlock({ tier: 1, text: "x".repeat(100), symbol: "t1a" }),
        makeBlock({ tier: 1, text: "x".repeat(100), symbol: "t1b" }),
        makeBlock({ tier: 1, text: "x".repeat(100), symbol: "t1c" }),
        makeBlock({ tier: 1, text: "x".repeat(100), symbol: "t1d" }),
        makeBlock({ tier: 2, text: "x".repeat(100), symbol: "t2a" }),
      ],
      maxTokens,
    );
    expect(result.text).toContain("t2a");
    expect(result.text).not.toContain("t1c");
  });

  test("a block that does not fit is written cut to 40 lines before it is dropped", () => {
    const base = "base";
    const headerTokens = render(base, [], 999999).totalTokens;
    const longText = Array.from({ length: 50 }, (_, i) => `// line ${i}`).join("\n");
    const big = makeBlock({ text: longText, symbol: "bigFn" });
    const full = render(base, [big], 999999);
    const maxTokens = full.totalTokens - 1;
    const result = render(base, [big], maxTokens);
    expect(result.text).toContain("cut at 40 lines for budget");
    expect(result.text).toContain("bigFn");
    expect(result.blocksWritten).toBe(1);
    expect(result.blocksDropped).toBe(0);
  });

  test("the output never exceeds the token budget with trimmed blocks and tier shares", () => {
    const base = "base";
    const longText = Array.from({ length: 50 }, (_, i) => `// line ${i}`).join("\n");
    const blocks = [
      makeBlock({ tier: 1, text: longText, symbol: "big1" }),
      makeBlock({ tier: 1, text: longText, symbol: "big2" }),
      makeBlock({ tier: 2, text: longText, symbol: "big3" }),
    ];
    for (const budget of [200, 500, 1000]) {
      const result = render(base, blocks, budget);
      expect(Math.ceil(result.text.length / 4)).toBeLessThanOrEqual(budget);
    }
  });
});
