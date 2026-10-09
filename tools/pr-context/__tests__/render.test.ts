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
