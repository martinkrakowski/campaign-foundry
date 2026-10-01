import { describe, expect, test } from "vitest";
import { runCli, type LaneVerifyCliIo } from "../cli.js";
import { REPO_ROOT, WAVE_EVENT_SCRIPT } from "../lib/emit.js";
import { EXIT_FAILED, EXIT_OK, EXIT_REFUSED } from "../lib/errors.js";
import {
  BRANCH,
  VERIFIED,
  WORKTREE,
  entry,
  fail,
  greenScript,
  ok,
  runnerFor,
  summary,
  type Answer,
} from "./fixtures.js";

const ARGV = [
  "--worktree",
  WORKTREE,
  "--branch",
  BRANCH,
  "--project",
  "tools",
  "--cover",
  "tools/lane-verify/**/*.ts",
];

const EMITTED = ["--emit", "wave-hardening-w06", "HXF11-lane-verify"];
/** The emit argv, up to the `--detail` whose JSON is the finished table. */
const SETTLED_KEY = `sh ${WAVE_EVENT_SCRIPT} wave-hardening-w06 HXF11-lane-verify gate settled --detail *`;
const FAILED_KEY = `sh ${WAVE_EVENT_SCRIPT} wave-hardening-w06 HXF11-lane-verify gate failed --detail *`;

interface Harness {
  readonly io: LaneVerifyCliIo;
  readonly out: string[];
  readonly err: string[];
  readonly calls: readonly {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
  }[];
}

function harness(
  script: Record<string, Answer> = greenScript(),
  over: Partial<LaneVerifyCliIo> = {},
  readFile: LaneVerifyCliIo["readFile"] = async () => summary({ "a.ts": entry() }),
): Harness {
  const { run, calls } = runnerFor(script);
  const out: string[] = [];
  const err: string[] = [];
  return {
    calls,
    out,
    err,
    io: {
      argv: ARGV,
      run,
      readFile,
      log: (text) => out.push(text),
      logError: (text) => err.push(text),
      ...over,
    },
  };
}

const withStep = (key: string, answer: Answer): Record<string, Answer> => ({
  ...greenScript(),
  [key]: answer,
});

describe("runCli", () => {
  test("no arguments at all is a usage refusal, and it costs no git call", async () => {
    const h = harness({});
    expect(await runCli({ ...h.io, argv: [] })).toBe(EXIT_REFUSED);
    expect(h.err[0]).toMatch(/^lane:verify: a --worktree is required\nusage: lane:verify /);
    expect(h.calls).toEqual([]);
  });

  test("an unknown flag is a usage refusal", async () => {
    const h = harness({});
    expect(await runCli({ ...h.io, argv: [...ARGV, "--json"] })).toBe(EXIT_REFUSED);
    expect(h.err[0]).toContain("unknown argument '--json'");
  });

  test("a green run prints one table and the verified sha", async () => {
    const h = harness();
    expect(await runCli(h.io)).toBe(EXIT_OK);
    expect(h.out).toHaveLength(2);
    expect(h.out[0]?.split("\n")).toHaveLength(8);
    expect(h.out[0]).toMatch(/^fetch\s+0\s+\(no output\)$/m);
    expect(h.out[1]).toBe(`verified ${VERIFIED}`);
    expect(h.err).toEqual([]);
  });

  test("a refused worktree exits 2 with the reason, and prints no table", async () => {
    const h = harness({
      ...greenScript(),
      "git rev-parse --git-dir": ok("/repo/.git"),
      "git rev-parse --git-common-dir": ok("/repo/.git"),
    });
    expect(await runCli(h.io)).toBe(EXIT_REFUSED);
    expect(h.err[0]).toMatch(/^lane:verify: refusing to verify: .*MAIN worktree/);
    expect(h.out).toEqual([]);
  });

  test("a HEAD that cannot be recorded is refused before any checkout", async () => {
    const h = harness(withStep("git rev-parse HEAD", fail(128)));
    expect(await runCli(h.io)).toBe(EXIT_REFUSED);
    expect(h.err[0]).toMatch(/refusing to verify: .*nothing to restore/);
  });

  test("a red step is exit 1 and still says what was verified", async () => {
    const h = harness(withStep("yarn typecheck", fail(2, "", "error TS2345\n")));
    expect(await runCli(h.io)).toBe(EXIT_FAILED);
    expect(h.out[0]).toMatch(/^typecheck\s+2\s+error TS2345$/m);
    expect(h.out[1]).toBe(`verified ${VERIFIED}`);
  });

  test("a checkout that failed prints that nothing was verified", async () => {
    const h = harness(withStep(`git checkout -q --detach origin/${BRANCH}`, fail(1)));
    expect(await runCli(h.io)).toBe(EXIT_FAILED);
    expect(h.out[1]).toBe("verified: nothing was checked out");
  });

  test("a runner that could not be LAUNCHED is exit 1, and the launch failure is the answer", async () => {
    // Not a refusal: the worktree was allowed, and this tool failed to do its
    // job on it. Exit 1 with the launch failure, rather than a table with an
    // empty step in it and no reason anywhere.
    const h = harness();
    const real = h.io.run;
    const code = await runCli({
      ...h.io,
      run: (command, args, options) =>
        args[0] === "fetch"
          ? (() => {
              throw new Error("spawn git ENOENT");
            })()
          : real(command, args, options),
    });
    expect(code).toBe(EXIT_FAILED);
    expect(h.err[0]).toBe("lane:verify: spawn git ENOENT");
  });
});

describe("--emit", () => {
  test("a green run writes ONE gate event, settled, in THIS repo and not the worktree", async () => {
    const h = harness(withStep(SETTLED_KEY, ok()), { argv: [...ARGV, ...EMITTED] });
    expect(await runCli(h.io)).toBe(EXIT_OK);
    const events = h.calls.filter((c) => c.command === "sh");
    expect(events).toHaveLength(1);
    expect(events[0]?.args.slice(0, 5)).toEqual([
      WAVE_EVENT_SCRIPT,
      "wave-hardening-w06",
      "HXF11-lane-verify",
      "gate",
      "settled",
    ]);
    expect(events[0]?.cwd).toBe(REPO_ROOT);
    expect(events[0]?.cwd).not.toBe(WORKTREE);
  });

  test("a red run writes the same event as failed", async () => {
    const h = harness(
      { ...withStep(FAILED_KEY, ok()), "yarn typecheck": fail(2, "", "error TS2345\n") },
      { argv: [...ARGV, ...EMITTED] },
    );
    expect(await runCli(h.io)).toBe(EXIT_FAILED);
    expect(h.calls.filter((c) => c.command === "sh")).toHaveLength(1);
  });

  test("the detail is the printed table, so the event and the table cannot disagree", async () => {
    const h = harness(
      { ...withStep(FAILED_KEY, ok()) },
      { argv: [...ARGV, ...EMITTED] },
      async () => summary({ "a.ts": entry({ branches: 99.5 }) }),
    );
    expect(await runCli(h.io)).toBe(EXIT_FAILED);
    const event = h.calls.find((c) => c.command === "sh");
    const detailIndex = event?.args.indexOf("--detail") ?? -1;
    const detail = JSON.parse(event?.args[detailIndex + 1] as string) as {
      steps: { step: string; exit: number; key: string }[];
      verified: string;
    };
    expect(detail.verified).toBe(VERIFIED);
    expect(detail.steps).toHaveLength(8);
    expect(detail.steps.find((s) => s.step === "coverage")).toEqual({
      step: "coverage",
      exit: 1,
      key: "1 file(s) under 100: a.ts  branches",
    });
    // The same rows, in the same order, are what was printed: the first two
    // columns of the table are the step and the exit, read back out of it.
    const printed = (h.out[0] ?? "").split("\n").map((line) => line.trim().split(/\s{2,}/));
    expect(detail.steps.map((s) => `${s.step} ${s.exit}`)).toEqual(
      printed.map(([step, exit]) => `${step} ${exit}`),
    );
  });

  test("--logdir reaches the script only when it was given", async () => {
    const withDir = harness(
      withStep(
        `sh ${WAVE_EVENT_SCRIPT} --logdir /logs/w06 wave-hardening-w06 HXF11-lane-verify gate settled --detail *`,
        ok(),
      ),
      {
        argv: [...ARGV, ...EMITTED, "--logdir", "/logs/w06"],
      },
    );
    expect(await runCli(withDir.io)).toBe(EXIT_OK);
    expect(withDir.calls.find((c) => c.command === "sh")?.args.slice(1, 3)).toEqual([
      "--logdir",
      "/logs/w06",
    ]);

    const without = harness(withStep(SETTLED_KEY, ok()), { argv: [...ARGV, ...EMITTED] });
    expect(await runCli(without.io)).toBe(EXIT_OK);
    expect(without.calls.find((c) => c.command === "sh")?.args).not.toContain("--logdir");
  });

  test("the event is written AFTER the restore, so a failed event cannot strand the tree", async () => {
    const h = harness(withStep(SETTLED_KEY, ok()), { argv: [...ARGV, ...EMITTED] });
    expect(await runCli(h.io)).toBe(EXIT_OK);
    const last = h.calls.at(-1);
    expect(last?.command).toBe("sh");
    expect(h.calls.at(-2)?.args).toEqual(["checkout", "-q", BRANCH]);
  });

  test("an event that could not be written is the answer when the check was green", async () => {
    const h = harness(greenScript(), { argv: [...ARGV, ...EMITTED] });
    expect(await runCli(h.io)).toBe(EXIT_FAILED);
    expect(h.err.at(-1)).toMatch(/wave-event\.sh could not be run: no scripted answer/);
  });

  test("the check's own red code stands even when the event is refused too", async () => {
    const h = harness(
      {
        ...withStep(FAILED_KEY, fail(2, "", "invalid lane\n")),
        "yarn typecheck": fail(2, "", "error TS2345\n"),
      },
      { argv: [...ARGV, ...EMITTED] },
    );
    expect(await runCli(h.io)).toBe(EXIT_FAILED);
    expect(h.err).toEqual(["wave-event.sh: invalid lane"]);
  });
});
