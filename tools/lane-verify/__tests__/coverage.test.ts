import { describe, expect, test } from "vitest";
import { COVERAGE_SUMMARY, underHundred } from "../lib/coverage.js";
import { entry, summary } from "./fixtures.js";

describe("underHundred", () => {
  test("names nothing when every metric of every file is at 100", () => {
    expect(underHundred(summary({ "a.ts": entry(), "b.ts": entry() }))).toEqual([]);
  });

  test("the total key is never reported: it is the run's aggregate, not a file", () => {
    const text = JSON.stringify({ "a.ts": entry(), total: entry({ lines: 99.9 }) });
    expect(underHundred(text)).toEqual([]);
  });

  test("a file short in ONE branch is reported, naming only that branch", () => {
    expect(underHundred(summary({ "a.ts": entry({ branches: 99.5 }) }))).toEqual([
      "a.ts  branches",
    ]);
  });

  test("every metric that is short is named, and a file short in several is one row", () => {
    expect(underHundred(summary({ "a.ts": entry({ lines: 100 - 1e-9, functions: 50 }) }))).toEqual([
      "a.ts  lines functions",
    ]);
  });

  test("99.999 and 99.5 are both under 100 — the check is not a rounding", () => {
    expect(underHundred(summary({ "a.ts": entry({ statements: 99.999 }) }))).toEqual([
      "a.ts  statements",
    ]);
  });

  test('a pct of "Unknown" is not 100, so an unmeasurable file is reported', () => {
    const unknown = { ...entry(), lines: { total: 0, covered: 0, skipped: 0, pct: "Unknown" } };
    expect(underHundred(summary({ "a.ts": unknown }))).toEqual(["a.ts  lines"]);
  });

  test("a bucket that is missing outright is not 100 either", () => {
    const gutted = { ...entry(), branches: undefined };
    expect(underHundred(summary({ "a.ts": gutted }))).toEqual(["a.ts  branches"]);
  });

  test("several files are each one row, in the order the summary lists them", () => {
    const rows = underHundred(summary({ "b.ts": entry(), "a.ts": entry({ statements: 12.5 }) }));
    expect(rows).toEqual(["a.ts  statements"]);
  });

  test("a summary that is not an object of files is refused rather than read", () => {
    for (const text of ["[]", "null", '"nope"', "12"]) {
      expect(() => underHundred(text)).toThrow(/not a JSON object of files/);
    }
    expect(() => underHundred("{")).toThrow();
  });
});

describe("COVERAGE_SUMMARY", () => {
  test("is the path the json-summary reporter writes, relative to the worktree", () => {
    expect(COVERAGE_SUMMARY).toBe("coverage/coverage-summary.json");
  });
});
