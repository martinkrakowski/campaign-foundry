import { describe, expect, test } from "vitest";
import { COVERAGE_SUMMARY, measuredAnything, parseSummary, shortFiles } from "../lib/coverage.js";
import { EMPTY_SUMMARY, entry, summary } from "./fixtures.js";

const short = (text: string) => shortFiles(parseSummary(text));

describe("parseSummary", () => {
  test("reads a summary of files", () => {
    expect(parseSummary(summary({ "a.ts": entry() }))).toHaveProperty("a.ts");
  });

  test("a summary that is not an object of files is refused rather than read", () => {
    for (const text of ["[]", "null", '"nope"', "12"]) {
      expect(() => parseSummary(text)).toThrow(/not a JSON object of files/);
    }
    expect(() => parseSummary("{")).toThrow();
  });
});

describe("measuredAnything", () => {
  test("a summary with no per-file entry measured NOTHING, and that is not a pass", () => {
    // The bug this closes: a `--cover` glob that matches no file produces exactly
    // this document, and to `shortFiles` below it is indistinguishable from a
    // perfect run.
    expect(measuredAnything(parseSummary(EMPTY_SUMMARY))).toBe(false);
    expect(short(EMPTY_SUMMARY)).toEqual([]);
  });

  test("one file is enough", () => {
    expect(measuredAnything(parseSummary(summary({ "a.ts": entry() })))).toBe(true);
  });
});

describe("shortFiles", () => {
  test("names nothing when every metric of every file is at 100", () => {
    expect(short(summary({ "a.ts": entry(), "b.ts": entry() }))).toEqual([]);
  });

  test("the total key is never reported: it is the run's aggregate, not a file", () => {
    expect(short(JSON.stringify({ "a.ts": entry(), total: entry({ lines: 99.9 }) }))).toEqual([]);
  });

  test("a file short in ONE branch is reported, naming only that branch", () => {
    expect(short(summary({ "a.ts": entry({ branches: 99.5 }) }))).toEqual(["a.ts  branches"]);
  });

  test("every metric that is short is named, and a file short in several is one row", () => {
    expect(short(summary({ "a.ts": entry({ lines: 100 - 1e-9, functions: 50 }) }))).toEqual([
      "a.ts  lines functions",
    ]);
  });

  test("99.999 and 99.5 are both under 100 — the check is not a rounding", () => {
    expect(short(summary({ "a.ts": entry({ statements: 99.999 }) }))).toEqual(["a.ts  statements"]);
  });

  test('a pct of "Unknown" is not 100, so an unmeasurable file is reported', () => {
    const unknown = { ...entry(), lines: { total: 0, covered: 0, skipped: 0, pct: "Unknown" } };
    expect(short(summary({ "a.ts": unknown }))).toEqual(["a.ts  lines"]);
  });

  test("a bucket that is missing outright is not 100 either", () => {
    const gutted = { ...entry(), branches: undefined };
    expect(short(summary({ "a.ts": gutted }))).toEqual(["a.ts  branches"]);
  });

  test("only the file that is short is listed", () => {
    expect(short(summary({ "b.ts": entry(), "a.ts": entry({ statements: 12.5 }) }))).toEqual([
      "a.ts  statements",
    ]);
  });
});

describe("COVERAGE_SUMMARY", () => {
  test("is the path the json-summary reporter writes, relative to the worktree", () => {
    expect(COVERAGE_SUMMARY).toBe("coverage/coverage-summary.json");
  });
});
