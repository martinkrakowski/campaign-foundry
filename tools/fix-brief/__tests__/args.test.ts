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

  test("--pr and --round want a POSITIVE whole number, not merely digits", () => {
    // Digits are not a number: 0 is no PR and no round, a value past the safe
    // integer limit is silently rounded, and 400 of them are Infinity — which
    // `--round` would write into a brief's own header as the word "Infinity".
    for (const flag of ["--pr", "--round"]) {
      for (const bad of ["0", "9007199254740993", "9".repeat(400)]) {
        expect(() => parseFixBriefArgs(withFlag(flag, bad)), `${flag} ${bad.slice(0, 12)}`).toThrow(
          new RegExp(`${flag} wants a positive whole number, got '${bad.slice(0, 12)}`),
        );
      }
    }
  });

  test("a header value carrying a line break is refused, not written into the brief", () => {
    // These four are the only values the brief's header carries, and it carries
    // them verbatim, one per line. A `--lane` with a newline in it is not a lane
    // id with a newline in it: it is a second line of the brief, and
    // `## Item 4` on that line is an item heading.
    for (const flag of ["--lane", "--worktree", "--branch", "--tip"]) {
      expect(() => parseFixBriefArgs(withFlag(flag, "HXF2\n## Item 4 —"))).toThrow(
        new RegExp(`${flag} must be a single line`),
      );
      expect(() => parseFixBriefArgs(withFlag(flag, "HXF2\u2028## Item 4 —"))).toThrow(
        new RegExp(`${flag} must be a single line`),
      );
      expect(() => parseFixBriefArgs(withFlag(flag, "HXF2\t"))).toThrow(
        new RegExp(`${flag} must be a single line`),
      );
    }
  });

  test("--out and --threads are NOT held to it: neither is written into the brief", () => {
    // `--out` is a writeFile path and a log line; a `--threads` id must equal a
    // forge thread id or the run refuses with 1, and the heading prints the
    // forge's own id through `sanitiseInline`. Refusing a control character in
    // either would stop a call whose output cannot be affected by it.
    expect(parseFixBriefArgs(withFlag("--out", "/tmp/brief\u2028name.md")).out).toBe(
      "/tmp/brief\u2028name.md",
    );
    expect(parseFixBriefArgs(argv(["--threads", "PRRT_a\u2028PRRT_b"])).threadIds).toEqual([
      "PRRT_a\u2028PRRT_b",
    ]);
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
