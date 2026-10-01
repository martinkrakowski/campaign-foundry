import { describe, expect, test } from "vitest";
import { BRIEF_NEW_USAGE, parseBriefNewArgs } from "../lib/args.js";

const argv = (extra: readonly string[] = []): string[] => [
  "--lane",
  "HXF7",
  "--plan",
  "docs/planning/2026-09-29_wave-hardening-and-w05-follow-ups.md",
  "--worktree",
  "/mnt/pool/cloud-services/projects/.worktrees/cf-hxf7",
  "--branch",
  "feat/brief-generator",
  "--tip",
  "9f3c8d2a",
  "--host",
  "midnight",
  "--out",
  ".agents/briefs/HXF7.md",
  ...extra,
];

/** The same command line with one flag's value REPLACED, not appended beside it. */
const withFlag = (flag: string, value: string): string[] => {
  const at = argv().indexOf(flag);
  return [...argv().slice(0, at + 1), value, ...argv().slice(at + 2)];
};

describe("parseBriefNewArgs", () => {
  test("the happy path, with --env-file absent: the environment block stays a placeholder", () => {
    expect(parseBriefNewArgs(argv())).toEqual({
      lane: "HXF7",
      plan: "docs/planning/2026-09-29_wave-hardening-and-w05-follow-ups.md",
      worktree: "/mnt/pool/cloud-services/projects/.worktrees/cf-hxf7",
      branch: "feat/brief-generator",
      tip: "9f3c8d2a",
      host: "midnight",
      out: ".agents/briefs/HXF7.md",
    });
    expect(parseBriefNewArgs(argv()).envFile).toBeUndefined();
  });

  test("--host mac is as good a host as midnight", () => {
    expect(parseBriefNewArgs(withFlag("--host", "mac")).host).toBe("mac");
  });

  test("--env-file is one path, and it is optional", () => {
    expect(parseBriefNewArgs(argv(["--env-file", "env.sh"])).envFile).toBe("env.sh");
  });

  test("every required flag is required", () => {
    const required = ["--lane", "--plan", "--worktree", "--branch", "--tip", "--host", "--out"];
    for (const flag of required) {
      const at = argv().indexOf(flag);
      const without = [...argv().slice(0, at), ...argv().slice(at + 2)];
      expect(() => parseBriefNewArgs(without), `${flag} was dropped`).toThrow(
        new RegExp(`a ${flag} is required|an ${flag} is required`),
      );
    }
  });

  test("an option starved of its value is refused", () => {
    for (const flag of ["--lane", "--plan", "--worktree", "--branch", "--tip", "--host", "--out"]) {
      expect(() => parseBriefNewArgs([flag])).toThrow(new RegExp(`missing value for ${flag}`));
    }
    // A flag cannot eat the next flag either.
    expect(() => parseBriefNewArgs(["--lane", "--plan", "p.md"])).toThrow(
      /missing value for --lane/,
    );
  });

  test("an empty value is refused, not rendered into an empty bullet", () => {
    expect(() => parseBriefNewArgs(withFlag("--lane", ""))).toThrow(
      /--lane was given an empty value/,
    );
    expect(() => parseBriefNewArgs(withFlag("--out", "   "))).toThrow(
      /--out was given an empty value/,
    );
    expect(() => parseBriefNewArgs(argv(["--env-file", "\t"]))).toThrow(
      /--env-file was given an empty value/,
    );
  });

  test("a flag given twice is refused — every flag here states one value", () => {
    expect(() => parseBriefNewArgs(argv(["--lane", "HXF1"]))).toThrow(/--lane is given twice/);
    expect(() => parseBriefNewArgs(argv(["--env-file", "a", "--env-file", "b"]))).toThrow(
      /--env-file is given twice/,
    );
  });

  test("a header value carrying a line break is refused, not written into the brief", () => {
    // These are the values the brief's header carries, and it carries them
    // verbatim, one per line. A `--lane` with a newline in it is not a lane id
    // with a newline in it: it is a second line of the brief, and `## Item 4` on
    // that line would read as an instruction to whoever is dispatched with it.
    for (const flag of ["--lane", "--plan", "--worktree", "--branch", "--tip"]) {
      expect(() => parseBriefNewArgs(withFlag(flag, "HXF7\n## Item 4 —"))).toThrow(
        new RegExp(`${flag} must be a single line`),
      );
      expect(() => parseBriefNewArgs(withFlag(flag, "HXF7\u2028## Item 4 —"))).toThrow(
        new RegExp(`${flag} must be a single line`),
      );
      expect(() => parseBriefNewArgs(withFlag(flag, "HXF7\t"))).toThrow(
        new RegExp(`${flag} must be a single line`),
      );
    }
  });

  test("--out, --env-file and --host are NOT held to it: none of the three is written into the brief", () => {
    // `--out` is a writeFile path and a log line, `--env-file` is a readFile path,
    // and `--host` picks one of two constant blocks. Refusing a control character
    // in any of them would stop a call whose output cannot be affected by it —
    // which is why `--out` may still be refused for BEING THERE, but not for the
    // shape of its name.
    expect(parseBriefNewArgs(withFlag("--out", "/tmp/brief\u2028name.md")).out).toBe(
      "/tmp/brief\u2028name.md",
    );
    expect(parseBriefNewArgs(argv(["--env-file", "/tmp/env\u2028.sh"])).envFile).toBe(
      "/tmp/env\u2028.sh",
    );
  });

  test("--host is exactly midnight or mac — there is no third block to fall back to", () => {
    // An unknown host would otherwise render a brief whose verification section
    // was empty, and an empty verification section is the one omission a lane
    // cannot notice: it looks like a section that had nothing to say.
    for (const bad of ["Midnight", "midnight ", "linux", "midnight,mac"]) {
      expect(() => parseBriefNewArgs(withFlag("--host", bad)), bad).toThrow(
        /--host wants midnight or mac/,
      );
    }
    // An empty one is refused by the shared rule first, naming the emptiness —
    // which is the reason that actually applies to it.
    expect(() => parseBriefNewArgs(withFlag("--host", ""))).toThrow(
      /--host was given an empty value/,
    );
  });

  test("--worktree is absolute: the brief's first bullet is where the lane works", () => {
    for (const bad of [".agents", "worktrees/cf-hxf7", "./cf-hxf7", "../cf-hxf7"]) {
      expect(() => parseBriefNewArgs(withFlag("--worktree", bad)), bad).toThrow(
        /--worktree must be an absolute path/,
      );
    }
    // A line break is refused for being two lines, before the absolute check is
    // reached, so the message names the reason that actually applies.
    expect(() => parseBriefNewArgs(withFlag("--worktree", "a\nb"))).toThrow(
      /--worktree must be a single line/,
    );
  });

  test("an unknown argument is refused, and the usage line says what is expected", () => {
    try {
      parseBriefNewArgs(argv(["--pr", "361"]));
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as Error).message).toContain("unknown argument '--pr'");
      expect((error as Error).message).toContain(BRIEF_NEW_USAGE);
    }
  });

  test("no arguments at all is a refusal, before anything is read or written", () => {
    expect(() => parseBriefNewArgs([])).toThrow(/a --lane is required/);
  });
});
