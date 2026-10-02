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

/** The default push reports: a throwaway, for the cases that are not about warnings. */
function quiet(): (text: string) => void {
  return () => undefined;
}

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
  test("a lane id the service would refuse never reaches the wire, and is named once", () => {
    const warns: string[] = [];
    const body = toPushLanes(
      [lane({ lane: "good" }), lane({ lane: "-lead" }), lane({ lane: "" })],
      (text) => warns.push(text),
    );
    expect(body.lanes).toEqual([{ id: "good", derived: { alive: true }, disagreements: [] }]);
    expect(warns).toHaveLength(2);
    expect(warns[0]).toContain('"-lead"');
    expect(warns[1]).toContain('""');
  });

  test("every key the client accepts, and nothing else", () => {
    expect(toPushLanes([full], quiet())).toEqual(fullBody);
  });

  test("the body is the literal the client reads on stdin", () => {
    expect(JSON.stringify(toPushLanes([full], quiet()))).toBe(JSON.stringify(fullBody));
  });

  test("a lane that gathered nothing optional omits every optional key", () => {
    const body = toPushLanes([lane({ lane: "bare" })], quiet());
    expect(body.lanes[0]).toEqual({ id: "bare", derived: { alive: true }, disagreements: [] });
    const keys = Object.keys(body.lanes[0] as object);
    expect(keys).not.toContain("seat");
    expect(keys).not.toContain("reported");
  });

  test("each derived key is omitted when the lane never gathered it", () => {
    const { derived } = toPushLanes([lane()], quiet()).lanes[0] as {
      derived: Record<string, unknown>;
    };
    for (const key of ["exit", "gate", "pr", "diff", "log", "planReview", "risk"]) {
      expect(Object.keys(derived)).not.toContain(key);
    }
    expect(Object.keys(derived)).toEqual(["alive"]);
  });

  test("a derived key outside the list does not reach the wire", () => {
    const surprise = { alive: false, backlog: ["nope"], coverage: 1 } as unknown as DerivedLane;
    const derived = (
      toPushLanes([lane({ derived: surprise })], quiet()).lanes[0] as { derived: unknown }
    ).derived;
    expect(derived).toEqual({ alive: false });
  });

  test("the log tail is dropped: the client strips it and it is 16 KiB a lane", () => {
    const derived = (toPushLanes([full], quiet()).lanes[0] as { derived: { log: object } }).derived;
    expect(derived.log).toEqual({ bytes: 4096, mtimeMs: NOW - 1000 });
    expect(Object.keys(derived.log)).not.toContain("tail");
  });

  test("id is the lane's lane; wave and lane are never keys", () => {
    const body = toPushLanes([lane({ wave: "W1", lane: "l2" })], quiet()).lanes[0] as Record<
      string,
      unknown
    >;
    expect(body.id).toBe("l2");
    expect(Object.keys(body)).not.toContain("wave");
    expect(Object.keys(body)).not.toContain("lane");
  });

  test("no wave is a lane key either — it is the --wave argument", () => {
    const keys = Object.keys(toPushLanes([full], quiet()).lanes[0] as object);
    expect(keys).toEqual(["id", "seat", "reported", "derived", "disagreements"]);
  });

  // F2 — the service closes every nested shape too, so a key any of them gains
  // later would refuse the whole wave on every tick. Each one is built from a
  // list, never forwarded as it is.
  test("reported carries exactly stage, event, ts, pr, round and detail", () => {
    const surprise = {
      stage: "gate",
      event: "settled",
      ts: NOW_ISO,
      pr: 42,
      round: 2,
      detail: { fixed: 1 },
      wave: "W",
      lane: "l1",
    } as unknown as NonNullable<LaneStatus["reported"]>;
    const pushed = toPushLanes([lane({ reported: surprise })], quiet()).lanes[0] as {
      reported: object;
    };
    expect(pushed.reported).toEqual({
      stage: "gate",
      event: "settled",
      ts: NOW_ISO,
      pr: 42,
      round: 2,
      detail: { fixed: 1 },
    });
    expect(Object.keys(pushed.reported)).not.toContain("wave");
  });

  test("every reported key is omitted when the event carried none", () => {
    const bare = toPushLanes(
      [lane({ reported: { stage: "gate", event: "failed", ts: NOW_ISO } })],
      quiet(),
    ).lanes[0] as { reported: object };
    expect(bare.reported).toEqual({ stage: "gate", event: "failed", ts: NOW_ISO });
  });

  test("derived.pr carries exactly number, state, checks and unresolvedThreads", () => {
    const surprise = {
      number: 42,
      state: "open",
      checks: "pending",
      unresolvedThreads: 3,
      headRefName: "lane",
      mergedBy: "someone",
    } as unknown as NonNullable<DerivedLane["pr"]>;
    const { derived } = toPushLanes([lane({ derived: { alive: true, pr: surprise } })], quiet())
      .lanes[0] as { derived: { pr: object } };
    expect(derived.pr).toEqual({
      number: 42,
      state: "open",
      checks: "pending",
      unresolvedThreads: 3,
    });
    expect(Object.keys(derived.pr)).not.toContain("headRefName");
  });

  test("an absent unresolvedThreads is left out, not sent as undefined", () => {
    const { derived } = toPushLanes([full], quiet()).lanes[0] as {
      derived: { pr: object };
    };
    expect(Object.keys(derived.pr)).toEqual(["number", "state", "checks", "unresolvedThreads"]);
    const minimal = toPushLanes(
      [
        lane({
          derived: {
            alive: true,
            pr: { number: 1, state: "open", checks: "pass" },
          },
        }),
      ],
      quiet(),
    ).lanes[0] as { derived: { pr: object } };
    expect(minimal.derived.pr).toEqual({ number: 1, state: "open", checks: "pass" });
  });

  test("derived.gate carries exit and coverage, and coverage its four numbers", () => {
    const surprise = {
      exit: 0,
      coverage: { statements: 1, branches: 1, functions: 1, lines: 1, uncovered: 3 },
      log: "gate.log",
      durationMs: 9,
    } as unknown as NonNullable<DerivedLane["gate"]>;
    const { derived } = toPushLanes([lane({ derived: { alive: false, gate: surprise } })], quiet())
      .lanes[0] as { derived: { gate: { exit?: number; coverage?: object } } };
    expect(derived.gate).toEqual({
      exit: 0,
      coverage: { statements: 1, branches: 1, functions: 1, lines: 1 },
    });
    expect(derived.gate.coverage && Object.keys(derived.gate.coverage)).not.toContain("uncovered");
  });

  test("a gate with neither an exit nor a coverage is an empty object, not a refused key", () => {
    const { derived } = toPushLanes([lane({ derived: { alive: false, gate: {} } })], quiet())
      .lanes[0] as { derived: { gate: object } };
    expect(derived.gate).toEqual({});
  });

  test("derived.diff carries exactly files, insertions and deletions", () => {
    const surprise = {
      files: 2,
      insertions: 10,
      deletions: 1,
      binaries: 0,
      generated: false,
    } as unknown as NonNullable<DerivedLane["diff"]>;
    const { derived } = toPushLanes([lane({ derived: { alive: true, diff: surprise } })], quiet())
      .lanes[0] as { derived: { diff: object } };
    expect(derived.diff).toEqual({ files: 2, insertions: 10, deletions: 1 });
    expect(Object.keys(derived.diff)).not.toContain("binaries");
  });

  test("a diff with a count missing omits only that key", () => {
    // Nothing gathers `diff` yet; when the numstat reader lands, a file with only
    // insertions has no deletions column. The type promises three, so each absent
    // side is reached the only honest way: a value that is not quite that type.
    const onlyInserts = { files: 1, insertions: 2 } as unknown as NonNullable<DerivedLane["diff"]>;
    const onlyFiles = { files: 3 } as unknown as NonNullable<DerivedLane["diff"]>;
    const onlyDeletes = { deletions: 9 } as unknown as NonNullable<DerivedLane["diff"]>;
    const wire = (diff: NonNullable<DerivedLane["diff"]>): object =>
      (
        toPushLanes([lane({ derived: { alive: true, diff } })], quiet()).lanes[0] as {
          derived: { diff: object };
        }
      ).derived.diff;
    expect(wire(onlyInserts)).toEqual({ files: 1, insertions: 2 });
    expect(wire(onlyFiles)).toEqual({ files: 3 });
    expect(wire(onlyDeletes)).toEqual({ deletions: 9 });
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

  test("a refused wave nobody asked for and that has gone quiet says nothing", () => {
    warns.length = 0;
    // A stale directory with a bad name is not news every tick, for hours.
    const old = wave("bad name", [laneAt(new Date(NOW - 8 * DAY).toISOString())]);
    const selected = selectWaves(statusOf([old, wave("U", [freshLane()])]), none, NOW, warn);
    expect(ids(selected)).toEqual(["U"]);
    expect(warns).toEqual([]);
  });

  test("a refused wave that IS recent is named once, because it would have gone out", () => {
    warns.length = 0;
    const selected = selectWaves(statusOf([wave("bad name", [freshLane()])]), none, NOW, warn);
    expect(ids(selected)).toEqual([]);
    expect(warns).toEqual([
      'waves push: skipping wave "bad name": the service would refuse that id',
    ]);
  });

  test("a refused wave named with --wave is named, whatever its activity", () => {
    warns.length = 0;
    const old = wave("bad name", [laneAt(new Date(NOW - 8 * DAY).toISOString())]);
    const selected = selectWaves(statusOf([old]), named("bad name"), NOW, warn);
    expect(ids(selected)).toEqual([]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('"bad name"');
  });

  test("a refused wave with no lanes is not worth a line: it was never going out", () => {
    warns.length = 0;
    const selected = selectWaves(statusOf([wave("bad name", [])]), none, NOW, warn);
    expect(ids(selected)).toEqual([]);
    expect(warns).toEqual([]);
  });

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
  test("a refused id is named once for the life of a caller, not once a tick", async () => {
    const { deps, runs, warns } = fakeDeps({ warned: new Set<string>() });
    const status = statusOf([wave("bad name", [freshLane()]), wave("W", [freshLane()])]);
    await pushStatus(deps, status, none);
    await pushStatus(deps, status, none);
    expect(warns.filter((text) => text.includes("the service would refuse that id"))).toHaveLength(
      1,
    );
    expect(runs).toHaveLength(2);
  });

  test("a refused LANE is named once too, for the same reason", async () => {
    const { deps, warns } = fakeDeps({ warned: new Set<string>() });
    const status = statusOf([wave("W", [lane({ lane: "good" }), lane({ lane: "-lead" })])]);
    await pushStatus(deps, status, named("W"));
    await pushStatus(deps, status, named("W"));
    expect(warns.filter((text) => text.includes('"-lead"'))).toHaveLength(1);
  });

  test("a push failure is news every time and is never de-duplicated", async () => {
    const { deps, warns } = fakeDeps({
      warned: new Set<string>(),
      run: async () => ({ code: 2, stderr: "waves push: the envelope is not valid:" }),
    });
    const status = statusOf([wave("W", [freshLane()])]);
    await pushStatus(deps, status, none);
    await pushStatus(deps, status, none);
    expect(warns.filter((text) => text.includes("exit 2"))).toHaveLength(2);
  });

  test("with no warned set the caller keeps its own memory, so nothing is suppressed", async () => {
    const { deps, warns } = fakeDeps();
    const status = statusOf([wave("bad name", [freshLane()])]);
    await pushStatus(deps, status, none);
    await pushStatus(deps, status, none);
    expect(warns.filter((text) => text.includes("the service would refuse that id"))).toHaveLength(
      2,
    );
  });

  test("one refused lane costs its wave only that lane", async () => {
    const { deps, runs, warns } = fakeDeps();
    const status = statusOf([
      wave("W", [lane({ lane: "good" }), lane({ lane: "-lead" }), lane({ lane: "other" })]),
    ]);
    await pushStatus(deps, status, named("W"));
    expect(runs).toHaveLength(1);
    expect(JSON.parse(runs[0]!.stdin)).toEqual({
      lanes: [
        { id: "good", derived: { alive: true }, disagreements: [] },
        { id: "other", derived: { alive: true }, disagreements: [] },
      ],
    });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('"-lead"');
  });

  test("a wave whose every lane is refused is not pushed, and run is never called for it", async () => {
    const { deps, runs, warns } = fakeDeps();
    const status = statusOf([
      wave("W", [lane({ lane: "-lead" }), lane({ lane: "" })]),
      wave("V", [lane({ lane: "v1" })]),
    ]);
    const pushed = await pushStatus(deps, status, named("W", "V"));
    expect(runs.map((r) => r.args[2])).toEqual(["V"]);
    expect(pushed).toBe(1);
    expect(warns.filter((text) => text.includes("nothing pushed"))).toEqual([
      "waves push: W: no lane the service would accept; nothing pushed",
    ]);
  });

  test("a wave nothing can be pushed for is not even spaced for", async () => {
    const { deps, sleeps } = fakeDeps();
    const status = statusOf([
      wave("W", [lane({ lane: "-lead" })]),
      wave("V", [lane({ lane: "v1" })]),
    ]);
    await pushStatus(deps, status, named("W", "V"));
    expect(sleeps).toEqual([]);
  });

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

  test("one warned set for the life of the process, so a refusal is said once", async () => {
    const wired = realPushDeps({}, quiet());
    expect(wired.warned).toBeInstanceOf(Set);
    // The same deps object every tick is what makes this stick; a fresh set per
    // call would put the same line on stderr once per interval for hours.
    expect(realPushDeps({}, quiet()).warned).not.toBe(wired.warned);
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
