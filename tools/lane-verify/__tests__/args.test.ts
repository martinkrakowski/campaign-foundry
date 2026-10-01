import { describe, expect, test } from "vitest";
import { LANE_VERIFY_USAGE, parseLaneVerifyArgs } from "../lib/args.js";

const BASE = [
  "--worktree",
  "/wt/lane",
  "--branch",
  "feat/lane",
  "--project",
  "tools",
  "--cover",
  "tools/lane-verify/**/*.ts",
];

const parse = (argv: readonly string[]) => parseLaneVerifyArgs(argv);

describe("parseLaneVerifyArgs", () => {
  test("reads the four required flags and nothing optional", () => {
    expect(parse(BASE)).toEqual({
      worktree: "/wt/lane",
      branch: "feat/lane",
      project: "tools",
      cover: ["tools/lane-verify/**/*.ts"],
      test: [],
      emit: null,
      logdir: null,
    });
  });

  test("--cover and --test are repeatable, one glob and one path each", () => {
    const plan = parse([
      ...BASE,
      "--cover",
      "tools/other/**/*.ts",
      "--test",
      "tools/lane-verify/__tests__/args.test.ts",
      "--test",
      "tools/lane-verify/__tests__/git.test.ts",
    ]);
    expect(plan.cover).toEqual(["tools/lane-verify/**/*.ts", "tools/other/**/*.ts"]);
    expect(plan.test).toEqual([
      "tools/lane-verify/__tests__/args.test.ts",
      "tools/lane-verify/__tests__/git.test.ts",
    ]);
  });

  test("--emit takes its wave and lane positionally, and --logdir is carried", () => {
    const plan = parse([
      ...BASE,
      "--emit",
      "wave-hardening-w06",
      "HXF11-lane-verify",
      "--logdir",
      "/logs/w06",
    ]);
    expect(plan.emit).toEqual({ wave: "wave-hardening-w06", lane: "HXF11-lane-verify" });
    expect(plan.logdir).toBe("/logs/w06");
  });

  test("a wave or lane outside the script's token class is refused before any work", () => {
    for (const bad of ["w 6", 'l"1', "wave/6", "a.b", "../etc"]) {
      expect(() => parse([...BASE, "--emit", bad, "l1"])).toThrow(/must match/);
      expect(() => parse([...BASE, "--emit", "w1", bad])).toThrow(/must match/);
    }
    // An empty token is the empty-value rule rather than the token rule, and it
    // stops at the same place: before anything is fetched or checked out.
    expect(() => parse([...BASE, "--emit", "", "l1"])).toThrow(/--emit was given an empty value/);
  });

  test("a relative --worktree is refused: every call is made in that directory", () => {
    expect(() => parse(["--worktree", "lane", ...BASE.slice(2)])).toThrow(
      /--worktree must be an absolute path/,
    );
  });

  test("a value that would write a line of its own is refused", () => {
    for (const flag of ["--cover", "--test", "--logdir"]) {
      expect(() => parse([...BASE, flag, "a\nb"])).toThrow(/must be a single line/);
    }
    for (const [flag, rest] of [
      ["--worktree", BASE.slice(2)],
      ["--branch", [BASE[0], BASE[1], ...BASE.slice(4)]],
      ["--project", [...BASE.slice(0, 4), ...BASE.slice(6)]],
    ] as const) {
      expect(() => parse([flag, "a\nb", ...rest])).toThrow(/must be a single line/);
    }
    expect(() => parse([...BASE, "--emit", "a\nb", "l1"])).toThrow(/must be a single line/);
    expect(() => parse([...BASE, "--emit", "w1", "a\nb"])).toThrow(/must be a single line/);
  });

  test("an empty value is refused rather than run with", () => {
    expect(() => parse([...BASE, "--cover", "  "])).toThrow(/--cover was given an empty value/);
  });

  test("a flag given with nothing after it, or with another flag, is refused", () => {
    expect(() => parse([...BASE, "--logdir"])).toThrow(/missing value for --logdir/);
    expect(() => parse([...BASE, "--logdir", "--cover"])).toThrow(/missing value for --logdir/);
    expect(() => parse([...BASE, "--emit", "w1"])).toThrow(/missing value for --emit/);
  });

  test("each single-valued flag is refused twice", () => {
    for (const flag of ["--worktree", "--branch", "--project", "--logdir", "--emit"]) {
      const argv = flag === "--emit" ? [...BASE, "--emit", "w1", "l1"] : [...BASE, flag, "again"];
      expect(() =>
        parse([...argv, flag, ...(flag === "--emit" ? ["w1", "l1"] : ["again"])]),
      ).toThrow(/is given twice/);
    }
  });

  test("an unknown argument is refused by name", () => {
    expect(() => parse([...BASE, "--verbose"])).toThrow("unknown argument '--verbose'");
  });

  test("each required flag is named when it is missing", () => {
    expect(() => parse([])).toThrow(`a --worktree is required\n${LANE_VERIFY_USAGE}`);
    expect(() => parse(["--worktree", "/wt"])).toThrow(/a --branch is required/);
    expect(() => parse(["--worktree", "/wt", "--branch", "b"])).toThrow(/a --project is required/);
    expect(() => parse(["--worktree", "/wt", "--branch", "b", "--project", "p"])).toThrow(
      /at least one --cover is required/,
    );
  });

  test("a glob listed twice is refused: one file named twice reads as two findings", () => {
    expect(() => parse([...BASE, "--cover", "tools/lane-verify/**/*.ts"])).toThrow(
      /is listed twice: one file named twice reads as two findings/,
    );
  });
});
