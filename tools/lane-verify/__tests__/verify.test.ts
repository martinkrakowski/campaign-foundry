import { describe, expect, test } from "vitest";
import { EXIT_FAILED, EXIT_OK } from "../lib/errors.js";
import { keyLine, renderTable, verifyLane, vitestArgv } from "../lib/verify.js";
import {
  BRANCH,
  HEAD,
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
import type { LaneVerifyArgs } from "../lib/args.js";

const PLAN: LaneVerifyArgs = {
  worktree: WORKTREE,
  branch: BRANCH,
  project: "tools",
  cover: ["tools/lane-verify/**/*.ts"],
  test: [],
  emit: null,
  logdir: null,
};

const atHundred = { readFile: async () => summary({ "a.ts": entry() }) };

const withStep = (key: string, answer: Answer): Record<string, Answer> => ({
  ...greenScript(),
  [key]: answer,
});

describe("vitestArgv", () => {
  test("is the row's command line: project, coverage, one include per glob, the test paths", () => {
    expect(
      vitestArgv({
        ...PLAN,
        cover: ["tools/lane-verify/**/*.ts", "tools/other/**/*.ts"],
        test: ["tools/lane-verify/__tests__/git.test.ts"],
      }),
    ).toEqual([
      "vitest",
      "run",
      "--project",
      "tools",
      "--coverage",
      "--coverage.include=tools/lane-verify/**/*.ts",
      "--coverage.include=tools/other/**/*.ts",
      "--coverage.reporter=json-summary",
      "tools/lane-verify/__tests__/git.test.ts",
    ]);
  });
});

describe("verifyLane", () => {
  test("the MAIN worktree is refused, and nothing is fetched or checked out", async () => {
    const { run, calls } = runnerFor({
      ...greenScript(),
      "git rev-parse --git-dir": ok("/repo/.git"),
      "git rev-parse --git-common-dir": ok("/repo/.git"),
    });
    await expect(verifyLane(PLAN, { run, ...atHundred })).rejects.toThrow(/MAIN worktree/);
    expect(calls.map((c) => c.args.join(" "))).toEqual([
      "rev-parse --git-dir",
      "rev-parse --git-common-dir",
    ]);
  });

  test("a DIRTY worktree is refused before the fetch, and the fetch is the first call", async () => {
    const { run, calls } = runnerFor(withStep("git status --porcelain", ok(" M package.json\n")));
    await expect(verifyLane(PLAN, { run, ...atHundred })).rejects.toThrow(/tracked change/);
    expect(calls.at(-1)?.args.join(" ")).toBe("status --porcelain");
    expect(calls.some((c) => c.args.includes("fetch"))).toBe(false);
  });

  test("a stale node_modules is refused, and the checkout never happens", async () => {
    const { run, calls } = runnerFor(
      withStep(`git show origin/${BRANCH}:yarn.lock`, ok("a different lockfile\n")),
    );
    await expect(verifyLane(PLAN, { run, ...atHundred })).rejects.toThrow(/node_modules is stale/);
    expect(calls.some((c) => c.args.includes("checkout"))).toBe(false);
  });

  test("all green exits 0, restores the branch, and names the sha it verified", async () => {
    const { run, calls } = runnerFor(greenScript());
    const outcome = await verifyLane(PLAN, { run, ...atHundred });
    expect(outcome.code).toBe(EXIT_OK);
    expect(outcome.verified).toBe(VERIFIED);
    expect(calls.at(-1)?.args).toEqual(["checkout", "-q", BRANCH]);
    expect(outcome.rows.map((r) => `${r.step} ${r.exit} ${r.key}`)).toEqual([
      "fetch 0 (no output)",
      "checkout 0 (no output)",
      `head 0 ${VERIFIED}`,
      "tests 0 Test Files  1 passed (1)",
      "coverage 0 every covered file at 100% in lines, branches, functions and statements",
      "typecheck 0 (no output)",
      "format:check 0 All matched files use Prettier code style!",
      "restore 0 (no output)",
    ]);
    // One key column for all eight rows: a table whose key line started at a
    // different column on each row is not scannable. The offset is the longest
    // step name, then a two-space gap, then the two-column exit, then a gap.
    const table = renderTable(outcome.rows).split("\n");
    const keyColumns = outcome.rows.map((row, i) => (table[i] ?? "").indexOf(row.key));
    expect(new Set(keyColumns).size).toBe(1);
    expect(keyColumns[0]).toBe("format:check".length + 2 + 2 + 2);
    expect(table[0]).toMatch(/^fetch\s+0\s+\(no output\)$/);
  });

  test("a red step exits 1, and the worktree is restored anyway", async () => {
    const { run, calls } = runnerFor(
      withStep(
        "yarn vitest run --project tools --coverage --coverage.include=tools/lane-verify/**/*.ts --coverage.reporter=json-summary",
        fail(1, "", "  1 failed\n"),
      ),
    );
    const outcome = await verifyLane(PLAN, { run, ...atHundred });
    expect(outcome.code).toBe(EXIT_FAILED);
    expect(outcome.rows.find((r) => r.step === "tests")).toEqual({
      step: "tests",
      exit: 1,
      key: "1 failed",
    });
    // Every LATER step still ran: the table is the whole answer in one pass.
    expect(outcome.rows.map((r) => r.step)).toEqual([
      "fetch",
      "checkout",
      "head",
      "tests",
      "coverage",
      "typecheck",
      "format:check",
      "restore",
    ]);
    expect(calls.at(-1)?.args).toEqual(["checkout", "-q", BRANCH]);
  });

  test("a file at 99.5% branches is LISTED and exits 1, though every line ran", async () => {
    const { run } = runnerFor(greenScript());
    const outcome = await verifyLane(PLAN, {
      run,
      readFile: async () => summary({ "a.ts": entry({ branches: 99.5 }), "b.ts": entry() }),
    });
    expect(outcome.code).toBe(EXIT_FAILED);
    expect(outcome.rows.find((r) => r.step === "coverage")).toEqual({
      step: "coverage",
      exit: 1,
      key: "1 file(s) under 100: a.ts  branches",
    });
  });

  test("a summary that is missing is a red coverage step, not a silent pass", async () => {
    const { run } = runnerFor(greenScript());
    const outcome = await verifyLane(PLAN, {
      run,
      readFile: async () => {
        throw new Error("ENOENT: no such file or directory");
      },
    });
    expect(outcome.code).toBe(EXIT_FAILED);
    expect(outcome.rows.find((r) => r.step === "coverage")?.key).toMatch(
      /^cannot use coverage\/coverage-summary\.json: ENOENT/,
    );
  });

  test("a coverage read that rejects with something that is not an Error still names itself", async () => {
    const { run } = runnerFor(greenScript());
    const outcome = await verifyLane(PLAN, {
      run,
      readFile: async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw "EACCES: permission denied";
      },
    });
    expect(outcome.rows.find((r) => r.step === "coverage")?.key).toBe(
      "cannot use coverage/coverage-summary.json: EACCES: permission denied",
    );
  });

  test("the summary is read from the WORKTREE, not from wherever this tool was run", async () => {
    const read: string[] = [];
    const { run } = runnerFor(greenScript());
    await verifyLane(PLAN, {
      run,
      readFile: async (path) => {
        read.push(path);
        return summary({ "a.ts": entry() });
      },
    });
    expect(read).toEqual([`${WORKTREE}/coverage/coverage-summary.json`]);
  });

  test("HEAD is restored when the runner THROWS mid-run, and the throw still comes out", async () => {
    const vitest =
      "vitest run --project tools --coverage --coverage.include=tools/lane-verify/**/*.ts --coverage.reporter=json-summary";
    // The fake throws on the vitest call and answers every other one, so the
    // `finally`'s restore really runs rather than failing beside it.
    const { run, calls } = runnerFor(greenScript(), {
      onCall: (call) => {
        if (call.args.join(" ") === vitest) throw new Error("runner vanished");
      },
    });
    const outcome = await verifyLane(PLAN, { run, ...atHundred }).then(
      () => null,
      (error: Error) => error,
    );
    expect(outcome?.message).toBe("runner vanished");
    expect(calls.at(-1)?.args).toEqual(["checkout", "-q", BRANCH]);
  });

  test("a checkout that failed leaves nothing verified, and still restores", async () => {
    const { run } = runnerFor(
      withStep(`git checkout -q --detach origin/${BRANCH}`, fail(1, "", "would be overwritten\n")),
    );
    const outcome = await verifyLane(PLAN, { run, ...atHundred });
    expect(outcome.code).toBe(EXIT_FAILED);
    expect(outcome.verified).toBeNull();
    expect(outcome.rows.some((r) => r.step === "head")).toBe(false);
  });

  test("a HEAD that cannot be read back after a good checkout is a red row", async () => {
    const { run } = runnerFor({
      ...greenScript(),
      "git rev-parse HEAD": [ok(`${HEAD}\n`), fail(128)],
    });
    const outcome = await verifyLane(PLAN, { run, ...atHundred });
    expect(outcome.code).toBe(EXIT_FAILED);
    expect(outcome.verified).toBeNull();
    expect(outcome.rows.find((r) => r.step === "head")?.exit).toBe(128);
  });

  test("a restore that failed is a red row: the operator's tree is not back", async () => {
    const { run } = runnerFor(
      withStep(`git checkout -q ${BRANCH}`, fail(1, "", "pathspec did not match\n")),
    );
    const outcome = await verifyLane(PLAN, { run, ...atHundred });
    expect(outcome.code).toBe(EXIT_FAILED);
    expect(outcome.rows.at(-1)).toEqual({
      step: "restore",
      exit: 1,
      key: "pathspec did not match",
    });
  });

  test("the run fetches ORIGIN only, one branch, before it records the HEAD", async () => {
    const { run, calls } = runnerFor(greenScript());
    await verifyLane(PLAN, { run, ...atHundred });
    expect(calls[3]).toEqual({
      command: "git",
      args: ["fetch", "-q", "origin", BRANCH],
      cwd: WORKTREE,
    });
    expect(calls.every((c) => c.cwd === WORKTREE)).toBe(true);
  });
});

describe("keyLine", () => {
  test("is the last non-empty line of stdout", () => {
    expect(keyLine({ code: 0, stdout: "a\n\nb\n\n", stderr: "ignored\n" })).toBe("b");
  });

  test("falls back to stderr when stdout said nothing", () => {
    expect(keyLine({ code: 1, stdout: "\n", stderr: "  boom  \n" })).toBe("boom");
  });

  test("says so plainly when a step said nothing at all", () => {
    expect(keyLine({ code: 0, stdout: "", stderr: "" })).toBe("(no output)");
  });
});
