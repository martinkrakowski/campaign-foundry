import { EventEmitter } from "node:events";
import { describe, expect, test, vi, type Mock } from "vitest";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

import { execFile } from "node:child_process";
import {
  DEFAULT_WAVES_PROJECT,
  MAX_INTERVAL_SECONDS,
  PUSH_SPACING_MS,
  RECENT_WAVE_MS,
  intervalFor,
  pushStatus,
  realPushDeps,
  selectWaves,
  toPushLanes,
  type PushDeps,
  type PushOptions,
} from "../push.js";
import type { DerivedLane, LaneStatus, WaveStatus } from "../types.js";

const NOW = Date.parse("2026-10-02T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const NOW_ISO = "2026-10-02T12:00:00Z";

type Wave = WaveStatus["waves"][number];

function lane(overrides: Partial<LaneStatus> = {}): LaneStatus {
  return { wave: "W", lane: "l", derived: { alive: true }, disagreements: [], ...overrides };
}

/** A lane whose only dated fact is an event at `ts`. */
function laneAt(ts: string, overrides: Partial<LaneStatus> = {}): LaneStatus {
  return lane({ reported: { stage: "implement", event: "settled", ts }, ...overrides });
}

/** A lane recent enough that the default selection finds its wave. */
function freshLane(overrides: Partial<LaneStatus> = {}): LaneStatus {
  return laneAt(NOW_ISO, overrides);
}

function wave(id: string, lanes: readonly LaneStatus[]): Wave {
  return { id, lanes };
}

function statusOf(waves: readonly Wave[]): WaveStatus {
  return { generatedAt: NOW_ISO, waves };
}

/** "These waves", named — which is what `--wave` does. */
function named(...waves: readonly string[]): PushOptions {
  return { waves, watch: false };
}

/** The default: every wave with activity in the last week. */
const none: PushOptions = { waves: [], watch: false };

interface Recorded {
  readonly deps: PushDeps;
  readonly runs: { readonly args: readonly string[]; readonly stdin: string }[];
  readonly sleeps: number[];
  readonly warns: string[];
}

/** A dep set that records everything and never touches a process or a real clock. */
function fakeDeps(overrides: Partial<PushDeps> = {}): Recorded {
  const runs: { args: readonly string[]; stdin: string }[] = [];
  const sleeps: number[] = [];
  const warns: string[] = [];
  const deps: PushDeps = {
    run: async (args, stdin) => {
      runs.push({ args, stdin });
      return { code: 0, stderr: "" };
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    warn: (text) => {
      warns.push(text);
    },
    nowMs: () => NOW,
    ...overrides,
  };
  return { deps, runs, sleeps, warns };
}

/** The one `seat`, `reported` and `derived` key the client accepts, all present at once. */
const full: LaneStatus = {
  wave: "W",
  lane: "l1",
  seat: "implementer",
  reported: {
    stage: "gate",
    event: "settled",
    ts: NOW_ISO,
    pr: 42,
    round: 2,
    detail: { fixed: 1 },
  },
  derived: {
    alive: true,
    exit: 0,
    gate: { exit: 0, coverage: { statements: 100, branches: 100, functions: 100, lines: 100 } },
    pr: { number: 42, state: "open", checks: "pending", unresolvedThreads: 3 },
    diff: { files: 2, insertions: 10, deletions: 1 },
    log: { bytes: 4096, mtimeMs: NOW - 1000, tail: "x".repeat(16 * 1024) },
    planReview: "dispatched on an unreviewed row",
    risk: "high-risk PR open without pre-PR review",
  },
  disagreements: ["derived gate says pass, the page says pending"],
};

const fullBody = {
  lanes: [
    {
      id: "l1",
      seat: "implementer",
      reported: {
        stage: "gate",
        event: "settled",
        ts: NOW_ISO,
        pr: 42,
        round: 2,
        detail: { fixed: 1 },
      },
      derived: {
        alive: true,
        exit: 0,
        gate: { exit: 0, coverage: { statements: 100, branches: 100, functions: 100, lines: 100 } },
        pr: { number: 42, state: "open", checks: "pending", unresolvedThreads: 3 },
        diff: { files: 2, insertions: 10, deletions: 1 },
        log: { bytes: 4096, mtimeMs: NOW - 1000 },
        planReview: "dispatched on an unreviewed row",
        risk: "high-risk PR open without pre-PR review",
      },
      disagreements: ["derived gate says pass, the page says pending"],
    },
  ],
};

describe("toPushLanes", () => {
  test("every key the client accepts, and nothing else", () => {
    expect(toPushLanes([full])).toEqual(fullBody);
  });

  test("the body is the literal the client reads on stdin", () => {
    expect(JSON.stringify(toPushLanes([full]))).toBe(JSON.stringify(fullBody));
  });

  test("a lane that gathered nothing optional omits every optional key", () => {
    const body = toPushLanes([lane({ lane: "bare" })]);
    expect(body.lanes[0]).toEqual({ id: "bare", derived: { alive: true }, disagreements: [] });
    const keys = Object.keys(body.lanes[0] as object);
    expect(keys).not.toContain("seat");
    expect(keys).not.toContain("reported");
  });

  test("each derived key is omitted when the lane never gathered it", () => {
    const { derived } = toPushLanes([lane()]).lanes[0] as { derived: Record<string, unknown> };
    for (const key of ["exit", "gate", "pr", "diff", "log", "planReview", "risk"]) {
      expect(Object.keys(derived)).not.toContain(key);
    }
    expect(Object.keys(derived)).toEqual(["alive"]);
  });

  test("a derived key outside the list does not reach the wire", () => {
    const surprise = { alive: false, backlog: ["nope"], coverage: 1 } as unknown as DerivedLane;
    const derived = (toPushLanes([lane({ derived: surprise })]).lanes[0] as { derived: unknown })
      .derived;
    expect(derived).toEqual({ alive: false });
  });

  test("the log tail is dropped: the client strips it and it is 16 KiB a lane", () => {
    const derived = (toPushLanes([full]).lanes[0] as { derived: { log: object } }).derived;
    expect(derived.log).toEqual({ bytes: 4096, mtimeMs: NOW - 1000 });
    expect(Object.keys(derived.log)).not.toContain("tail");
  });

  test("id is the lane's lane; wave and lane are never keys", () => {
    const body = toPushLanes([lane({ wave: "W1", lane: "l2" })]).lanes[0] as Record<
      string,
      unknown
    >;
    expect(body.id).toBe("l2");
    expect(Object.keys(body)).not.toContain("wave");
    expect(Object.keys(body)).not.toContain("lane");
  });

  test("no wave is a lane key either — it is the --wave argument", () => {
    const keys = Object.keys(toPushLanes([full]).lanes[0] as object);
    expect(keys).toEqual(["id", "seat", "reported", "derived", "disagreements"]);
  });
});

describe("selectWaves", () => {
  const warns: string[] = [];
  const warn = (text: string): void => {
    warns.push(text);
  };

  function ids(selected: readonly Wave[]): string[] {
    return selected.map((w) => w.id);
  }

  test("a wave with no lanes is never selected", () => {
    warns.length = 0;
    const selected = selectWaves(
      statusOf([wave("T", []), wave("U", [freshLane()])]),
      none,
      NOW,
      warn,
    );
    expect(ids(selected)).toEqual(["U"]);
    expect(warns).toEqual([]);
  });

  test("named ids select exactly those, in the status's order", () => {
    warns.length = 0;
    const status = statusOf([wave("A", [lane()]), wave("B", [lane()]), wave("C", [lane()])]);
    const selected = selectWaves(status, named("C", "A"), NOW, warn);
    expect(ids(selected)).toEqual(["A", "C"]);
    expect(warns).toEqual([]);
  });

  test("an unknown named id warns once and names it", () => {
    warns.length = 0;
    const selected = selectWaves(statusOf([wave("A", [lane()])]), named("nope"), NOW, warn);
    expect(ids(selected)).toEqual([]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('"nope"');
  });

  test("a repeated unknown id warns once, not once per repetition", () => {
    warns.length = 0;
    const status = statusOf([wave("A", [lane()])]);
    selectWaves(status, named("nope", "nope", "nope"), NOW, warn);
    expect(warns).toHaveLength(1);
  });

  test("a named wave with no lanes warns, naming the id", () => {
    warns.length = 0;
    const status = statusOf([wave("A", []), wave("B", [lane()])]);
    const selected = selectWaves(status, named("A", "B"), NOW, warn);
    expect(ids(selected)).toEqual(["B"]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('"A"');
  });

  test("an id the service would refuse is skipped, with one warn that names it", () => {
    warns.length = 0;
    // An empty id is real: a log directory named exactly `wave`.
    const status = statusOf([
      wave("", [freshLane()]),
      wave("wave W", [freshLane()]),
      wave("wave.dot", [freshLane()]),
    ]);
    const selected = selectWaves(status, none, NOW, warn);
    expect(ids(selected)).toEqual([]);
    expect(warns).toHaveLength(3);
    expect(warns[0]).toContain('""');
    expect(warns[1]).toContain('"wave W"');
    expect(warns[2]).toContain('"wave.dot"');
  });

  test("an id named as refused is not also named as unknown", () => {
    warns.length = 0;
    const status = statusOf([wave("wave W", [freshLane()])]);
    expect(ids(selectWaves(status, named("wave W"), NOW, warn))).toEqual([]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("the service would refuse that id");
  });

  test("the default takes a wave whose newest report is 6 days old, not one 8 days old", () => {
    warns.length = 0;
    const status = statusOf([
      wave("six", [laneAt(new Date(NOW - 6 * DAY).toISOString())]),
      wave("eight", [laneAt(new Date(NOW - 8 * DAY).toISOString())]),
    ]);
    expect(ids(selectWaves(status, none, NOW, warn))).toEqual(["six"]);
  });

  test("the boundary — activity exactly RECENT_WAVE_MS old — is still selected", () => {
    warns.length = 0;
    const status = statusOf([wave("edge", [laneAt(new Date(NOW - RECENT_WAVE_MS).toISOString())])]);
    expect(ids(selectWaves(status, none, NOW, warn))).toEqual(["edge"]);
  });

  test("a log mtime alone dates a wave", () => {
    warns.length = 0;
    const status = statusOf([
      wave("byLog", [
        lane({ derived: { alive: false, log: { bytes: 1, mtimeMs: NOW - 60_000, tail: "" } } }),
      ]),
    ]);
    expect(ids(selectWaves(status, none, NOW, warn))).toEqual(["byLog"]);
  });

  test("an unparseable ts is silence, not the epoch", () => {
    warns.length = 0;
    // A log 60s old rescues the wave the garbled report cannot.
    const rescued = statusOf([
      wave("rescued", [
        lane({
          reported: { stage: "gate", event: "failed", ts: "not a date" },
          derived: { alive: true, log: { bytes: 1, mtimeMs: NOW - 60_000, tail: "" } },
        }),
      ]),
    ]);
    expect(ids(selectWaves(rescued, none, NOW, warn))).toEqual(["rescued"]);
    // Alone it dates nothing at all, so the wave is not recent.
    const garbled = statusOf([wave("garbled", [laneAt("not a date")])]);
    expect(ids(selectWaves(garbled, none, NOW, warn))).toEqual([]);
  });

  test("a wave with no datable activity is not selected", () => {
    warns.length = 0;
    expect(ids(selectWaves(statusOf([wave("silent", [lane()])]), none, NOW, warn))).toEqual([]);
  });
});

describe("intervalFor", () => {
  test("a one-shot push reports no interval at all", () => {
    expect(intervalFor(false, 3)).toBeUndefined();
  });

  test("the watch interval carries the tick's own spacing", () => {
    expect(intervalFor(10, 3)).toBe(14);
  });

  test("a value past the cap is capped", () => {
    expect(intervalFor(300, 10)).toBe(MAX_INTERVAL_SECONDS);
  });
});

describe("pushStatus", () => {
  test("the arguments are exactly the client's, with no interval on a one-shot", async () => {
    const { deps, runs } = fakeDeps();
    await pushStatus(deps, statusOf([wave("W", [lane()])]), named("W"));
    expect(runs.map((r) => r.args)).toEqual([["push", "--wave", "W", "--stdin"]]);
  });

  test("a watching push adds --interval, and the body is the lane json", async () => {
    const { deps, runs } = fakeDeps();
    await pushStatus(deps, statusOf([wave("W", [full])]), { waves: ["W"], watch: 10 });
    expect(runs[0]?.args).toEqual(["push", "--wave", "W", "--stdin", "--interval", "12"]);
    expect(runs[0]?.stdin).toBe(JSON.stringify(fullBody));
  });

  test("waves are pushed one at a time, in the order selected", async () => {
    const { deps, runs } = fakeDeps();
    const status = statusOf([wave("A", [lane()]), wave("B", [lane()]), wave("C", [lane()])]);
    await pushStatus(deps, status, named("C", "A"));
    expect(runs.map((r) => r.args[2])).toEqual(["A", "C"]);
  });

  test("the server's one-write-per-second is respected BETWEEN pushes, never at the ends", async () => {
    const three = fakeDeps();
    await pushStatus(
      three.deps,
      statusOf([wave("A", [lane()]), wave("B", [lane()]), wave("C", [lane()])]),
      named("A", "B", "C"),
    );
    expect(three.sleeps).toEqual([PUSH_SPACING_MS, PUSH_SPACING_MS]);

    const one = fakeDeps();
    await pushStatus(one.deps, statusOf([wave("A", [lane()])]), named("A"));
    expect(one.sleeps).toEqual([]);
  });

  test("a non-zero exit warns with the wave, the code and only what the client said", async () => {
    const { deps, warns } = fakeDeps({
      run: async () => ({
        code: 2,
        stderr: "\n  waves push: the envelope is not valid:\n  lanes[0].seat\n\n",
      }),
    });
    await pushStatus(deps, statusOf([wave("W", [lane()])]), named("W"));
    expect(warns).toEqual([
      "waves push: W: exit 2: waves push: the envelope is not valid: | lanes[0].seat",
    ]);
  });

  test("three stderr lines is the whole excerpt, and 300 characters is the hard cut", async () => {
    const { deps, warns } = fakeDeps({
      run: async () => ({ code: 1, stderr: `one\ntwo\nthree\nfour\n${"x".repeat(400)}` }),
    });
    await pushStatus(deps, statusOf([wave("W", [lane()])]), named("W"));
    expect(warns[0]).toBe("waves push: W: exit 1: one | two | three");

    const long = fakeDeps({ run: async () => ({ code: 1, stderr: "y".repeat(500) }) });
    await pushStatus(long.deps, statusOf([wave("W", [lane()])]), named("W"));
    expect(long.warns[0]).toBe(`waves push: W: exit 1: ${"y".repeat(300)}`);
  });

  test("a run that fails — a non-zero exit, or a rejection — never stops the next wave", async () => {
    const seen: string[] = [];
    const { deps, warns } = fakeDeps({
      run: async (args) => {
        const id = String(args[2]);
        seen.push(id);
        if (id === "A") return { code: 2, stderr: "waves push: the envelope is not valid:" };
        if (id === "B") throw new Error("spawn waves ENOENT");
        return { code: 0, stderr: "" };
      },
    });
    const pushed = await pushStatus(
      deps,
      statusOf([wave("A", [lane()]), wave("B", [lane()]), wave("C", [lane()])]),
      named("A", "B", "C"),
    );
    expect(seen).toEqual(["A", "B", "C"]);
    expect(warns).toEqual([
      "waves push: A: exit 2: waves push: the envelope is not valid:",
      "waves push: B: spawn waves ENOENT",
    ]);
    expect(pushed).toBe(1);
  });

  test("a rejection that is not an Error is still reported, with its text", async () => {
    const { deps, warns } = fakeDeps({
      run: async () => {
        throw "no waves binary";
      },
    });
    await pushStatus(deps, statusOf([wave("W", [lane()])]), named("W"));
    expect(warns).toEqual(["waves push: W: no waves binary"]);
  });

  test("it resolves with the number of waves the service took", async () => {
    const codes: Record<string, number> = { A: 0, B: 2, C: 0 };
    const { deps } = fakeDeps({
      run: async (args) => ({ code: codes[String(args[2])] ?? 0, stderr: "" }),
    });
    const pushed = await pushStatus(
      deps,
      statusOf([wave("A", [lane()]), wave("B", [lane()]), wave("C", [lane()])]),
      named("A", "B", "C"),
    );
    expect(pushed).toBe(2);
  });

  test("no selected wave means run is never called at all", async () => {
    const { deps, runs } = fakeDeps();
    await expect(pushStatus(deps, statusOf([wave("W", [lane()])]), none)).resolves.toBe(0);
    expect(runs).toEqual([]);
  });

  test("a --watch near the cap warns once, because the service will read the waves stale", async () => {
    const over = fakeDeps();
    await pushStatus(over.deps, statusOf([wave("W", [lane()])]), { waves: ["W"], watch: 299 });
    expect(over.warns).toHaveLength(1);
    expect(over.warns[0]).toContain("stale between pushes");
    expect(over.runs[0]?.args).toEqual(["push", "--wave", "W", "--stdin", "--interval", "300"]);

    const exact = fakeDeps();
    await pushStatus(exact.deps, statusOf([wave("W", [lane()])]), { waves: ["W"], watch: 298 });
    expect(exact.warns).toEqual([]);
    expect(exact.runs[0]?.args).toContain("300");
  });

  test("a warn that throws never stops a push or rejects", async () => {
    const { deps, runs } = fakeDeps({
      warn: () => {
        throw new Error("stderr is gone");
      },
    });
    const pushed = await pushStatus(
      deps,
      statusOf([wave("A", [lane()]), wave("B", [lane()])]),
      named("A", "B"),
    );
    expect(runs).toHaveLength(2);
    expect(pushed).toBe(2);
  });

  test("a sleep that rejects is no reason to skip the waves that remain", async () => {
    const { deps, runs } = fakeDeps({
      sleep: async () => {
        throw new Error("interrupted");
      },
    });
    await pushStatus(
      deps,
      statusOf([wave("A", [lane()]), wave("B", [lane()]), wave("C", [lane()])]),
      named("A", "B", "C"),
    );
    expect(runs).toHaveLength(3);
  });

  test("an id the service would refuse is warned about by selectWaves, not pushed", async () => {
    const { deps, warns, runs } = fakeDeps();
    await pushStatus(deps, statusOf([wave("", [lane()])]), named(""));
    expect(runs).toEqual([]);
    expect(warns).toHaveLength(1);
  });
});

type ExecError = Error & { code?: number | string | null; killed?: boolean };
type ExecCallback = (error: ExecError | null, stdout: string, stderr: string) => void;

interface ExecCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: Record<string, unknown>;
  readonly stdin: (EventEmitter & { end: Mock }) | null;
  readonly written: string[];
}

const execFileMock = execFile as unknown as Mock;
let lastCall: ExecCall;

/**
 * A stub child whose stdin is a real EventEmitter, so emitting `error` with no
 * listener throws exactly as it would in a process — which is what makes the
 * closed-pipe test able to fail.
 */
function stubExec(
  outcome: (call: ExecCall) => [ExecError | null, string],
  onTick?: (call: ExecCall) => void,
  withStdin = true,
): void {
  execFileMock.mockImplementation(
    (
      file: string,
      args: readonly string[],
      options: Record<string, unknown>,
      callback: ExecCallback,
    ) => {
      const written: string[] = [];
      const stdin: (EventEmitter & { end: Mock }) | null = withStdin
        ? Object.assign(new EventEmitter(), {
            end: vi.fn((text?: string) => {
              written.push(text ?? "");
            }),
          })
        : null;
      lastCall = { file, args, options, stdin, written };
      queueMicrotask(() => {
        onTick?.(lastCall);
        const [error, stderr] = outcome(lastCall);
        callback(error, "", stderr);
      });
      return lastCall;
    },
  );
}

const execExit = (code: number): ExecError => Object.assign(new Error(`exit ${code}`), { code });

describe("realPushDeps — the process-level wiring", () => {
  const deps = realPushDeps({}, () => undefined);

  test("run executes the installed client by its pinned path — never a shell", async () => {
    stubExec(() => [null, ""]);
    await deps.run(["push", "--wave", "W", "--stdin"], '{"lanes":[]}');
    expect(lastCall.file.endsWith("/node_modules/.bin/waves")).toBe(true);
    expect(lastCall.args).toEqual(["push", "--wave", "W", "--stdin"]);
    expect(lastCall.options["shell"]).toBeUndefined();
    expect(lastCall.options["timeout"]).toBe(60_000);
  });

  test("the child's env is ours, with WAVES_PROJECT filled in only when the environment names none", async () => {
    stubExec(() => [null, ""]);
    await realPushDeps({}, () => undefined).run([], "");
    expect((lastCall.options["env"] as NodeJS.ProcessEnv).WAVES_PROJECT).toBe(
      DEFAULT_WAVES_PROJECT,
    );

    stubExec(() => [null, ""]);
    await realPushDeps({ WAVES_PROJECT: "" }, () => undefined).run([], "");
    expect((lastCall.options["env"] as NodeJS.ProcessEnv).WAVES_PROJECT).toBe(
      DEFAULT_WAVES_PROJECT,
    );

    stubExec(() => [null, ""]);
    await realPushDeps({ WAVES_PROJECT: "nightshift", OTHER: "kept" }, () => undefined).run([], "");
    expect(lastCall.options["env"]).toMatchObject({
      WAVES_PROJECT: "nightshift",
      OTHER: "kept",
    });
  });

  test("the body is written to stdin and the pipe is ended", async () => {
    stubExec(() => [null, ""]);
    await deps.run([], '{"lanes":[{"id":"l"}]}');
    expect(lastCall.stdin?.end).toHaveBeenCalledTimes(1);
    expect(lastCall.written).toEqual(['{"lanes":[{"id":"l"}]}']);
  });

  test("a client with no stdin pipe still settles from the callback", async () => {
    stubExec(() => [null, ""], undefined, false);
    await expect(deps.run([], "{}")).resolves.toEqual({ code: 0, stderr: "" });
    expect(lastCall.stdin).toBeNull();
  });

  test("a non-zero exit resolves with the code and its stderr — it is an answer, not a failure", async () => {
    stubExec(() => [execExit(2), "waves push: the envelope is not valid:"]);
    await expect(deps.run([], "{}")).resolves.toEqual({
      code: 2,
      stderr: "waves push: the envelope is not valid:",
    });
  });

  test("a process that never started rejects", async () => {
    stubExec(() => [Object.assign(new Error("spawn waves ENOENT"), { code: "ENOENT" }), ""]);
    await expect(deps.run([], "{}")).rejects.toThrow("spawn waves ENOENT");
  });

  test("a child the timeout killed rejects: a non-numeric code is no answer", async () => {
    stubExec(() => [
      Object.assign(new Error("Command failed"), { code: null, killed: true, signal: "SIGTERM" }),
      "",
    ]);
    await expect(deps.run([], "{}")).rejects.toMatchObject({ killed: true });
  });

  test("a closed stdin pipe is not an uncaught exception (the client exits before reading)", async () => {
    stubExec(
      () => [execExit(2), "usage: waves push"],
      (call) => {
        call.stdin?.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
      },
    );
    await expect(deps.run([], "{}")).resolves.toEqual({ code: 2, stderr: "usage: waves push" });
    expect(lastCall.stdin?.listenerCount("error")).toBe(1);
  });

  test("warn is the injected reporter and nowMs is the real clock", () => {
    const logError = vi.fn();
    const wired = realPushDeps({}, logError);
    wired.warn("waves push: W: exit 2: refused");
    expect(logError).toHaveBeenCalledWith("waves push: W: exit 2: refused");
    const before = Date.now();
    const read = wired.nowMs();
    expect(read).toBeGreaterThanOrEqual(before);
    expect(read).toBeLessThanOrEqual(Date.now());
  });

  test("sleep waits the interval it is given", async () => {
    vi.useFakeTimers();
    try {
      const started = deps.sleep(PUSH_SPACING_MS);
      let settled = false;
      void started.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(PUSH_SPACING_MS);
      await started;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
