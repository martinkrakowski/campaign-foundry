import { describe, expect, test } from "vitest";
import { EXIT_FAILED, EXIT_OK, LaneVerifyCrash } from "../lib/errors.js";
import { isGreen } from "../lib/errors.js";
import {
  diagnosticTail,
  keyLine,
  renderDiagnostics,
  renderTable,
  verifyLane,
  vitestArgv,
} from "../lib/verify.js";
import {
  BRANCH,
  EMPTY_SUMMARY,
  HEAD,
  SUMMARY_AT,
  VERIFIED,
  VITEST_KEY,
  WORKTREE,
  entry,
  fail,
  greenScript,
  laneIo,
  ok,
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

const withStep = (key: string, answer: Answer): Record<string, Answer> => ({
  ...greenScript(),
  [key]: answer,
});

const steps = (rows: readonly { step: string; state: string }[]) =>
  rows.map((row) => `${row.step}:${row.state}`);

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
    const h = laneIo({
      ...greenScript(),
      "git rev-parse --git-dir": ok("/repo/.git"),
      "git rev-parse --git-common-dir": ok("/repo/.git"),
    });
    await expect(verifyLane(PLAN, h.io)).rejects.toThrow(/MAIN worktree/);
    expect(h.calls.map((c) => c.args.join(" "))).toEqual([
      "rev-parse --git-dir",
      "rev-parse --git-common-dir",
    ]);
  });

  test("a DIRTY worktree is refused before the fetch", async () => {
    const h = laneIo(withStep("git status --porcelain", ok(" M package.json\n")));
    await expect(verifyLane(PLAN, h.io)).rejects.toThrow(/tracked change/);
    expect(h.calls.some((c) => c.args.includes("fetch"))).toBe(false);
  });

  test("a stale node_modules is refused, and the checkout never happens", async () => {
    const h = laneIo(withStep(`git show origin/${BRANCH}:yarn.lock`, ok("different\n")));
    await expect(verifyLane(PLAN, h.io)).rejects.toThrow(/node_modules is stale/);
    expect(h.calls.some((c) => c.args.includes("checkout"))).toBe(false);
  });

  test("all green exits 0, restores the branch, and names the sha it verified", async () => {
    const h = laneIo();
    const outcome = await verifyLane(PLAN, h.io);
    expect(outcome.code).toBe(EXIT_OK);
    expect(outcome.verified).toBe(VERIFIED);
    expect(h.calls.at(-1)?.args).toEqual(["checkout", "-q", BRANCH]);
    expect(outcome.rows.map((r) => `${r.step} ${r.exit} ${r.key}`)).toEqual([
      "fetch 0 (no output)",
      "checkout 0 (no output)",
      `head 0 ${VERIFIED}`,
      "preclean 0 removed the summary an earlier run left",
      "tests 0 Test Files  1 passed (1)",
      "coverage 0 every covered file at 100% in lines, branches, functions and statements",
      "typecheck 0 (no output)",
      "format:check 0 All matched files use Prettier code style!",
      "restore 0 (no output)",
    ]);
    expect(outcome.diagnostics).toEqual([]);
  });

  test("a red step exits 1, and the worktree is restored anyway", async () => {
    const h = laneIo(withStep(VITEST_KEY, fail(1, "", "  1 failed\n")));
    const outcome = await verifyLane(PLAN, h.io);
    expect(outcome.code).toBe(EXIT_FAILED);
    expect(outcome.rows.find((r) => r.step === "tests")).toEqual({
      step: "tests",
      state: "ran",
      exit: 1,
      key: "1 failed",
    });
    expect(steps(outcome.rows)).toEqual([
      "fetch:ran",
      "checkout:ran",
      "head:ran",
      "preclean:ran",
      "tests:ran",
      "coverage:ran",
      "typecheck:ran",
      "format:check:ran",
      "restore:ran",
    ]);
    expect(h.calls.at(-1)?.args).toEqual(["checkout", "-q", BRANCH]);
  });

  test("a file at 99.5% branches is LISTED and exits 1, though every line ran", async () => {
    const h = laneIo(greenScript(), async () => summary({ "a.ts": entry({ branches: 99.5 }) }));
    const outcome = await verifyLane(PLAN, h.io);
    expect(outcome.code).toBe(EXIT_FAILED);
    expect(outcome.rows.find((r) => r.step === "coverage")).toEqual({
      step: "coverage",
      state: "ran",
      exit: 1,
      key: "1 file(s) under 100: a.ts  branches",
    });
  });
});

describe("item 1 — an empty coverage run is red", () => {
  test("a --cover glob that matched nothing is red, naming the globs", async () => {
    // The fail-open this closes: `shortFiles` finds nothing in a summary with no
    // per-file entry, so without `measuredAnything` the row reads as a pass and
    // the run settles on a branch whose code was never measured at all.
    const h = laneIo(greenScript(), async () => EMPTY_SUMMARY);
    const outcome = await verifyLane(PLAN, h.io);
    expect(outcome.code).toBe(EXIT_FAILED);
    expect(outcome.rows.find((r) => r.step === "coverage")).toEqual({
      step: "coverage",
      state: "ran",
      exit: null,
      key: "no file matched --cover tools/lane-verify/**/*.ts",
    });
    // No diagnostic for the coverage step: it runs no command, so it has no
    // captured output, and its key line already names the globs that matched
    // nothing — which is the whole of what an operator needs to fix it.
    expect(outcome.diagnostics).toEqual([]);
  });

  test("every glob is named, so a quoting mistake is visible", async () => {
    const script = {
      ...greenScript(),
      "yarn vitest run --project tools --coverage --coverage.include=src/**/*.ts --coverage.include=lib/**/*.ts --coverage.reporter=json-summary":
        ok(),
    };
    const h = laneIo(script, async () => EMPTY_SUMMARY);
    const outcome = await verifyLane({ ...PLAN, cover: ["src/**/*.ts", "lib/**/*.ts"] }, h.io);
    expect(outcome.rows.find((r) => r.step === "coverage")?.key).toBe(
      "no file matched --cover src/**/*.ts lib/**/*.ts",
    );
  });
});

describe("item 2 — a failed fetch or checkout skips the rest", () => {
  test("a FAILED fetch stops before the lock check and the checkout", async () => {
    const h = laneIo(
      withStep("git fetch -q origin feat/lane", fail(128, "", "fatal: couldn't find remote ref\n")),
    );
    const outcome = await verifyLane(PLAN, h.io);
    expect(outcome.code).toBe(EXIT_FAILED);
    expect(steps(outcome.rows)).toEqual([
      "fetch:ran",
      "checkout:skipped",
      "head:skipped",
      "tests:skipped",
      "coverage:skipped",
      "typecheck:skipped",
      "format:check:skipped",
      "restore:ran",
    ]);
  });

  test("a missing ref surfaces the FETCH error, not a yarn.lock refusal", async () => {
    const h = laneIo(
      withStep("git fetch -q origin feat/lane", fail(128, "", "couldn't find remote ref\n")),
    );
    const outcome = await verifyLane(PLAN, h.io);
    expect(outcome.rows[0]?.key).toBe("couldn't find remote ref");
    // The lock comparison is skipped entirely: a branch that does not exist has
    // no origin/<branch>:yarn.lock, so answering that refusal would name a stale
    // node_modules as the reason when the real one is the missing ref.
    expect(h.calls.some((c) => c.args.join(" ").includes("yarn.lock"))).toBe(false);
    // No checkout of the BRANCH. The restore's own `git checkout -q <branch>`
    // still runs, and is the point: the worktree must come back either way.
    expect(h.calls.some((c) => c.args.includes("--detach"))).toBe(false);
    expect(h.calls.some((c) => c.args.includes("vitest"))).toBe(false);
  });

  test("a failed fetch is never green, and says why each row was skipped", async () => {
    const h = laneIo(withStep("git fetch -q origin feat/lane", fail(128, "", "no such ref\n")));
    const outcome = await verifyLane(PLAN, h.io);
    expect(outcome.rows.slice(1, -1).every((row) => !isGreen(row))).toBe(true);
    expect(outcome.rows[1]?.key).toBe("skipped: fetch failed");
    expect(renderTable(outcome.rows).split("\n")[1]).toMatch(
      /checkout\s+skipped\s+skipped: fetch failed/,
    );
  });

  test("a FAILED checkout runs no test command at all, and still restores", async () => {
    const h = laneIo(
      withStep(
        `git checkout -q --detach origin/${BRANCH}`,
        fail(1, "", "pathspec did not match\n"),
      ),
    );
    const outcome = await verifyLane(PLAN, h.io);
    expect(outcome.code).toBe(EXIT_FAILED);
    expect(h.calls.some((c) => c.args.includes("vitest"))).toBe(false);
    expect(h.calls.some((c) => c.args.join(" ") === "typecheck")).toBe(false);
    expect(steps(outcome.rows)).toEqual([
      "fetch:ran",
      "checkout:ran",
      "tests:skipped",
      "coverage:skipped",
      "typecheck:skipped",
      "format:check:skipped",
      "restore:ran",
    ]);
    expect(outcome.rows[2]?.key).toBe("skipped: checkout failed");
    expect(outcome.verified).toBeNull();
    expect(h.calls.at(-1)?.args).toEqual(["checkout", "-q", BRANCH]);
  });

  test("a skipped row is a distinct state in the table AND in the emitted detail", async () => {
    const h = laneIo(withStep("git fetch -q origin feat/lane", fail(1)));
    const outcome = await verifyLane(PLAN, h.io);
    // The word, not a zero: a reader and a script must both be unable to take
    // `skipped` for a pass.
    expect(JSON.stringify(outcome.rows)).toContain('"state":"skipped"');
    expect(JSON.stringify(outcome.rows)).toContain('"exit":null');
    expect(renderTable(outcome.rows)).toContain("skipped");
    expect(renderTable(outcome.rows)).not.toMatch(/checkout\s+0\s/);
  });
});

describe("item 3 — a stale summary is never reported as this run's", () => {
  test("the summary is deleted BEFORE vitest runs", async () => {
    const h = laneIo();
    await verifyLane(PLAN, h.io);
    expect(h.removed).toEqual([SUMMARY_AT]);
    // The order is the whole point: a summary left from an earlier run must not
    // survive into the window where this run's coverage is read.
    expect(h.events.indexOf(`unlink: ${SUMMARY_AT}`)).toBeLessThan(
      h.events.findIndex((event) => event.includes("vitest")),
    );
  });

  test("a pre-existing summary plus a vitest that writes none is RED, never the old numbers", async () => {
    // `readFile` stands for the state AFTER the run: vitest produced nothing.
    // Reading an old file here is exactly the stale-coverage bug, so the row must
    // say the summary is missing rather than quoting a previous lane's numbers.
    const h = laneIo(greenScript(), async () => {
      const error = new Error("ENOENT: no such file or directory");
      (error as NodeJS.ErrnoException).code = "ENOENT";
      throw error;
    });
    const outcome = await verifyLane(PLAN, h.io);
    expect(outcome.code).toBe(EXIT_FAILED);
    expect(outcome.rows.find((r) => r.step === "coverage")).toEqual({
      step: "coverage",
      state: "ran",
      exit: null,
      key: "vitest wrote no coverage summary at coverage/coverage-summary.json",
    });
  });

  test("a summary that is present but unparseable is red, and says which", async () => {
    const h = laneIo(greenScript(), async () => "{not json");
    const outcome = await verifyLane(PLAN, h.io);
    expect(outcome.rows.find((r) => r.step === "coverage")?.key).toMatch(
      /^cannot use coverage\/coverage-summary\.json: /,
    );
  });

  test("a read failure that is not ENOENT is red, and says what went wrong", async () => {
    const h = laneIo(greenScript(), async () => {
      throw new Error("EACCES: permission denied, open 'coverage-summary.json'");
    });
    const outcome = await verifyLane(PLAN, h.io);
    expect(outcome.rows.find((r) => r.step === "coverage")?.key).toBe(
      "cannot use coverage/coverage-summary.json: EACCES: permission denied, open 'coverage-summary.json'",
    );
  });

  test("an earlier summary that is there to remove is reported as removed", async () => {
    const h = laneIo(greenScript(), undefined, async () => undefined);
    const outcome = await verifyLane(PLAN, h.io);
    expect(outcome.rows.find((r) => r.step === "preclean")?.key).toBe(
      "removed the summary an earlier run left",
    );
  });

  test("a summary that CANNOT be removed makes the coverage step skipped, not read", async () => {
    // Fail closed: a file this tool could not delete is a file whose contents it
    // cannot vouch for, so it is not read at all.
    const h = laneIo(greenScript(), undefined, async () => {
      throw new Error("EPERM: operation not permitted, unlink");
    });
    const outcome = await verifyLane(PLAN, h.io);
    expect(outcome.code).toBe(EXIT_FAILED);
    expect(outcome.rows.find((r) => r.step === "preclean")?.exit).toBeNull();
    expect(outcome.rows.find((r) => r.step === "coverage")).toEqual({
      step: "coverage",
      state: "skipped",
      exit: null,
      key: "skipped: an earlier summary could not be removed, so none can be trusted",
    });
  });

  test("an ENOENT unlink is not a failure: a fresh worktree has no summary", async () => {
    const h = laneIo(greenScript(), undefined, async () => {
      const error = new Error("ENOENT: no such file or directory");
      (error as NodeJS.ErrnoException).code = "ENOENT";
      throw error;
    });
    const outcome = await verifyLane(PLAN, h.io);
    expect(outcome.code).toBe(EXIT_OK);
    expect(outcome.rows.find((r) => r.step === "preclean")).toEqual({
      step: "preclean",
      state: "ran",
      exit: 0,
      key: "no earlier summary to remove",
    });
  });
});

describe("item 4 — a crash carries the rows gathered so far", () => {
  test("the thrown thing names the failure AND keeps the table", async () => {
    const h = laneIo(greenScript(), undefined, undefined, {
      onCall: (call) => {
        if (call.args.join(" ") === VITEST_KEY.replace("yarn ", "")) {
          throw new Error("runner vanished");
        }
      },
    });
    const thrown = await verifyLane(PLAN, h.io).then(
      () => null,
      (error: LaneVerifyCrash) => error,
    );
    expect(thrown).toBeInstanceOf(LaneVerifyCrash);
    expect(thrown?.message).toBe("runner vanished");
    expect(thrown?.verified).toBe(VERIFIED);
    expect(steps(thrown?.rows ?? [])).toEqual([
      "fetch:ran",
      "checkout:ran",
      "head:ran",
      "preclean:ran",
      "restore:ran",
    ]);
  });

  test("HEAD is restored even though the body threw", async () => {
    const h = laneIo(greenScript(), undefined, undefined, {
      onCall: (call) => {
        if (call.args.join(" ") === VITEST_KEY.replace("yarn ", "")) throw new Error("gone");
      },
    });
    await verifyLane(PLAN, h.io).catch(() => undefined);
    expect(h.calls.at(-1)?.args).toEqual(["checkout", "-q", BRANCH]);
  });

  test("the recorded HEAD is published as soon as it is known, for the signal path", async () => {
    const h = laneIo();
    await verifyLane(PLAN, h.io);
    expect(h.recorded).toEqual([{ head: HEAD, branch: BRANCH }]);
  });

  test("a restore the signal path already did is SKIPPED, never done twice", async () => {
    const h = laneIo();
    h.io.latch.restored = true;
    const outcome = await verifyLane(PLAN, h.io);
    expect(outcome.rows.at(-1)).toEqual({
      step: "restore",
      state: "skipped",
      exit: null,
      key: "skipped: the signal path already restored this worktree",
    });
    expect(outcome.code).toBe(EXIT_FAILED);
    expect(
      h.calls.filter((c) => c.args[1] === "checkout" && !c.args.includes("--detach")),
    ).toHaveLength(0);
  });

  test("a restore that could not be run is red, and names the worktree at risk", async () => {
    const h = laneIo(
      withStep(`git checkout -q ${BRANCH}`, fail(1, "", "pathspec did not match\n")),
    );
    const outcome = await verifyLane(PLAN, h.io);
    expect(outcome.code).toBe(EXIT_FAILED);
    expect(outcome.rows.at(-1)?.exit).toBe(1);
  });

  test("a restore whose runner THROWS is a red row, not a lost run", async () => {
    const restoreKey = `checkout -q ${BRANCH}`;
    const h = laneIo(greenScript(), undefined, undefined, {
      onCall: (call) => {
        if (call.args.join(" ") === restoreKey) throw new Error("git is not here");
      },
    });
    const outcome = await verifyLane(PLAN, h.io);
    expect(outcome.code).toBe(EXIT_FAILED);
    expect(outcome.rows.at(-1)).toEqual({
      step: "restore",
      state: "ran",
      exit: null,
      key: `the restore could not be run: git is not here — ${WORKTREE} may still be on the lane branch`,
    });
  });
});

describe("item 5 — a red step keeps its diagnostics", () => {
  test("a red tests step prints its tail, stdout first", async () => {
    const h = laneIo(
      withStep(VITEST_KEY, fail(1, "FAIL  tools/a.test.ts\n  1 failed\n\n", "  assertion\n")),
    );
    const outcome = await verifyLane(PLAN, h.io);
    expect(outcome.diagnostics).toEqual([
      { step: "tests", exit: 1, text: "FAIL  tools/a.test.ts\n  1 failed\n  assertion" },
    ]);
  });

  test("a green step contributes nothing at all", async () => {
    const h = laneIo(withStep("yarn typecheck", fail(2, "", "error TS2345\nerror TS2345\n")));
    const outcome = await verifyLane(PLAN, h.io);
    expect(outcome.diagnostics.map((d) => d.step)).toEqual(["typecheck"]);
  });

  test("every red step is represented, in table order", async () => {
    const script = withStep(VITEST_KEY, fail(1, "tests failed\n"));
    script["yarn typecheck"] = fail(2, "typecheck failed\n");
    const outcome = await verifyLane(PLAN, laneIo(script).io);
    expect(outcome.diagnostics.map((d) => d.step)).toEqual(["tests", "typecheck"]);
  });

  test("the tail is the LAST forty lines, blank lines dropped", () => {
    const many = Array.from({ length: 60 }, (_unused, i) => `line ${i}`).join("\n");
    expect(diagnosticTail({ code: 1, stdout: `${many}\n\n\n`, stderr: "on stderr" })).toBe(
      [...Array.from({ length: 39 }, (_u, i) => `line ${i + 21}`), "on stderr"].join("\n"),
    );
  });

  test("the rendered tail names the step and its exit", () => {
    expect(
      renderDiagnostics([
        { step: "tests", exit: 1, text: "boom" },
        { step: "restore", exit: null, text: "gone" },
      ]),
    ).toBe("\n--- tests (exit 1) ---\nboom\n\n--- restore (no exit code) ---\ngone");
  });

  test("no red steps render to nothing at all", () => {
    expect(renderDiagnostics([])).toBe("");
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

describe("the table's shape", () => {
  test("every key line starts in the same column", async () => {
    const h = laneIo(withStep("yarn typecheck", fail(2, "", "error TS2345\n")));
    const outcome = await verifyLane(PLAN, h.io);
    const table = renderTable(outcome.rows).split("\n");
    const keyColumns = outcome.rows.map((row, i) => (table[i] ?? "").indexOf(row.key));
    expect(new Set(keyColumns).size).toBe(1);
    expect(keyColumns[0]).toBe("format:check".length + 2 + 7 + 2);
  });

  test("a row with no exit code says `none`, never a zero", async () => {
    // The empty-coverage row: the command ran, produced no exit status, and is
    // red. Printing `0` there would make an unmeasured branch look like a
    // measured one, which is the whole failure this column exists to prevent.
    const h = laneIo(greenScript(), async () => EMPTY_SUMMARY);
    const outcome = await verifyLane(PLAN, h.io);
    expect(
      renderTable(outcome.rows)
        .split("\n")
        .find((line) => line.startsWith("coverage")),
    ).toMatch(/^coverage\s+none\s+no file matched --cover /);
  });

  test("the run fetches ORIGIN only, one branch, and every call is in the worktree", async () => {
    const h = laneIo();
    await verifyLane(PLAN, h.io);
    expect(h.calls[3]).toEqual({
      command: "git",
      args: ["fetch", "-q", "origin", BRANCH],
      cwd: WORKTREE,
    });
    expect(h.calls.every((c) => c.cwd === WORKTREE)).toBe(true);
  });

  test("a HEAD that cannot be read back after a good checkout is a red row", async () => {
    const h = laneIo({
      ...greenScript(),
      "git rev-parse HEAD": [ok(`${HEAD}\n`), fail(128)],
    });
    const outcome = await verifyLane(PLAN, h.io);
    expect(outcome.code).toBe(EXIT_FAILED);
    // Nothing is named as verified: the run cannot say which commit it tested.
    expect(outcome.verified).toBeNull();
    expect(outcome.rows.find((r) => r.step === "head")?.exit).toBe(128);
  });

  test("the summary is read from the WORKTREE", async () => {
    const read: string[] = [];
    const h = laneIo(greenScript(), async (path) => {
      read.push(path);
      return summary({ "a.ts": entry() });
    });
    await verifyLane(PLAN, h.io);
    expect(read).toEqual([SUMMARY_AT]);
  });

  test("a coverage read that rejects with something that is not an Error still names itself", async () => {
    const h = laneIo(greenScript(), async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw "EACCES: permission denied";
    });
    const outcome = await verifyLane(PLAN, h.io);
    expect(outcome.rows.find((r) => r.step === "coverage")?.key).toBe(
      "cannot use coverage/coverage-summary.json: EACCES: permission denied",
    );
  });
});
