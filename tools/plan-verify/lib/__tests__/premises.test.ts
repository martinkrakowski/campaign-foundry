import { describe, expect, test } from "vitest";
import { parsePremises } from "../premises.js";

describe("parsePremises", () => {
  test("reads the lane id and the script out of a premise fence", () => {
    const md = ["# Plan", "", "```premise W4", "grep -q foo bar.ts", "```", ""].join("\n");
    expect(parsePremises("docs/planning/p.md", md)).toEqual([
      { plan: "docs/planning/p.md", lane: "W4", script: "grep -q foo bar.ts" },
    ]);
  });

  test("reads every premise in a document, in order", () => {
    const md = [
      "```premise A", "one", "```",
      "prose between",
      "```premise B", "two", "```",
    ].join("\n");
    expect(parsePremises("p.md", md).map((p) => p.lane)).toEqual(["A", "B"]);
  });

  test("keeps a multi-line script intact", () => {
    const md = ["```premise K1", "set -e", "grep -q a f.ts", "```"].join("\n");
    expect(parsePremises("p.md", md)[0]?.script).toBe("set -e\ngrep -q a f.ts");
  });

  test("ignores a plain fence, and a fence with no lane id", () => {
    const md = ["```sh", "grep -q foo bar.ts", "```", "```premise", "x", "```"].join("\n");
    expect(parsePremises("p.md", md)).toEqual([]);
  });

  test("ignores an empty premise — a lane that claims nothing is not falsifiable", () => {
    const md = ["```premise W9", "   ", "```"].join("\n");
    expect(parsePremises("p.md", md)).toEqual([]);
  });

  test("is re-entrant: the shared global regex cannot skip a document", () => {
    const md = ["```premise W1", "true", "```"].join("\n");
    expect(parsePremises("a.md", md)).toHaveLength(1);
    expect(parsePremises("b.md", md)).toHaveLength(1);
  });
});
