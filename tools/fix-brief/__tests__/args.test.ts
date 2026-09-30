import { describe, expect, test } from "vitest";
import { FIX_BRIEF_USAGE, parseFixBriefArgs } from "../lib/args.js";

const argv = (extra: readonly string[] = []): string[] => [
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
  ...extra,
];

/** The same command line with one flag's value REPLACED, not appended beside it. */
const withFlag = (flag: string, value: string): string[] => {
  const at = argv().indexOf(flag);
  return [...argv().slice(0, at + 1), value, ...argv().slice(at + 2)];
};

describe("parseFixBriefArgs", () => {
  test("the happy path, with --threads absent: every unresolved thread is the default", () => {
    expect(parseFixBriefArgs(argv())).toEqual({
      pr: 361,
      lane: "HXF2",
      round: 2,
      worktree: "/mnt/pool/cloud-services/projects/.worktrees/cf-hxf2",
      branch: "feat/fix-brief",
      tip: "be2b44ae",
      out: ".agents/briefs/scratch/HXF2-r2.md",
    });
    expect(parseFixBriefArgs(argv()).threadIds).toBeUndefined();
  });

  test("--threads is ONE comma-separated value, split on the comma", () => {
    const parsed = parseFixBriefArgs(argv(["--threads", "PRRT_b, PRRT_a"]));
    expect(parsed.threadIds).toEqual(["PRRT_b", "PRRT_a"]);
  });

  test("every required flag is required", () => {
    const required = ["--pr", "--lane", "--round", "--worktree", "--branch", "--tip", "--out"];
    for (const flag of required) {
      const at = argv().indexOf(flag);
      const without = [...argv().slice(0, at), ...argv().slice(at + 2)];
      expect(() => parseFixBriefArgs(without), `${flag} was dropped`).toThrow(
        new RegExp(`a ${flag} is required|an ${flag} is required`),
      );
    }
  });

  test("an option starved of its value is refused", () => {
    for (const flag of ["--pr", "--lane", "--round", "--worktree", "--branch", "--tip", "--out"]) {
      expect(() => parseFixBriefArgs([flag])).toThrow(new RegExp(`missing value for ${flag}`));
    }
    // A flag cannot eat the next flag either.
    expect(() => parseFixBriefArgs(["--pr", "--lane", "HXF2"])).toThrow(/missing value for --pr/);
  });

  test("an empty value is refused, not rendered into an empty heading", () => {
    expect(() => parseFixBriefArgs(withFlag("--lane", ""))).toThrow(
      /--lane was given an empty value/,
    );
    expect(() => parseFixBriefArgs(withFlag("--out", "   "))).toThrow(
      /--out was given an empty value/,
    );
    expect(() => parseFixBriefArgs([...argv(), "--threads", ""])).toThrow(
      /--threads was given an empty value/,
    );
  });

  test("a flag given twice is refused — every flag here states one value", () => {
    expect(() => parseFixBriefArgs(argv(["--lane", "HXF1"]))).toThrow(/--lane is given twice/);
    expect(() => parseFixBriefArgs(argv(["--threads", "PRRT_a", "--threads", "PRRT_b"]))).toThrow(
      /--threads is given twice/,
    );
  });

  test("an id listed twice in --threads is refused here, not by the forge", () => {
    expect(() => parseFixBriefArgs(argv(["--threads", "PRRT_a,PRRT_b,PRRT_a"]))).toThrow(
      /PRRT_a is listed twice/,
    );
    expect(() => parseFixBriefArgs(argv(["--threads", "PRRT_a,,PRRT_b"]))).toThrow(
      /--threads carries an empty id/,
    );
  });

  test("a non-numeric --pr or --round is refused", () => {
    expect(() => parseFixBriefArgs(withFlag("--pr", "abc"))).toThrow(/--pr wants a number/);
    expect(() => parseFixBriefArgs(withFlag("--round", "next"))).toThrow(/--round wants a number/);
  });

  test("an unknown argument is refused, and the usage line says what is expected", () => {
    try {
      parseFixBriefArgs(argv(["--post"]));
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as Error).message).toContain("unknown argument '--post'");
      expect((error as Error).message).toContain(FIX_BRIEF_USAGE);
    }
  });

  test("no arguments at all is a refusal, before anything is fetched", () => {
    expect(() => parseFixBriefArgs([])).toThrow(/a --pr is required/);
  });
});
