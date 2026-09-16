import { describe, test, expect, vi, type Mock } from "vitest";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

import { execFile } from "node:child_process";
import {
  collect,
  derivePrefix,
  joinPrForLane,
  LEGACY_WAVE_LOG_ROOT,
  LOG_TAIL_BYTES,
  parseChecks,
  parsePrList,
  pgrepPattern,
  prFacts,
  PR_PULLS_JQ,
  realDeps,
  resolveScanRoots,
  WAVE_LOG_ROOT,
  waveIdFromDirName,
  worktreeFacts,
  type CollectDeps,
  type PrFact,
  type TailHandle,
} from "../lib/collect.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { execFile: realExecFile } = await vi.importActual<typeof import("node:child_process")>("node:child_process");

const execFileMock = execFile as unknown as Mock;
execFileMock.mockImplementation(
  (file: string, args: readonly string[], optionsOrCallback: unknown, maybeCallback?: unknown) => {
    return (realExecFile as unknown as (...a: unknown[]) => unknown)(file, args, optionsOrCallback, maybeCallback);
  },
);

type ExecError = Error & { code?: number };
type ExecCallback = (error: ExecError | null, stdout: string) => void;

const execExit = (code: number): ExecError => Object.assign(new Error(`exit ${code}`), { code });

interface FakeTree {
  readonly dirs?: Record<string, readonly string[]>;
  readonly files?: Record<string, string>;
  readonly pgrep?: (pattern: string) => Promise<number>;
  readonly gh?: (args: readonly string[]) => Promise<string>;
  readonly git?: (args: readonly string[]) => Promise<string>;
  readonly planVerifyArtifactPath?: string;
}

function fakeDeps({
  dirs = {},
  files = {},
  pgrep = async () => 0,
  gh = async () => "[]",
  git,
  planVerifyArtifactPath = "/plan-verify.json",
}: FakeTree): CollectDeps {
  const missing = (what: string, path: string): Error =>
    Object.assign(new Error(`ENOENT: ${what} ${path}`), { code: "ENOENT" });
  return {
    readdir: async (dir) => {
      const names = dirs[dir];
      if (names === undefined) throw missing("readdir", dir);
      return names;
    },
    readFile: async (path) => {
      const text = files[path];
      if (text === undefined) throw missing("readFile", path);
      return text;
    },
    open: async (path) => {
      const text = files[path];
      if (text === undefined) throw missing("open", path);
      const data = Buffer.from(text, "utf8");
      return memoryHandle(data);
    },
    pgrep,
    gh,
    planVerifyArtifactPath,
    ...(git ? { git } : {}),
  };
}

function memoryHandle(data: Buffer, mtimeMs = 1_000): TailHandle {
  return {
    async stat() {
      return { size: data.length, mtimeMs };
    },
    async read(buffer, offset, length, position) {
      const n = Math.max(0, Math.min(length, data.length - position));
      if (n > 0) {
        new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength).set(
          data.subarray(position, position + n),
          offset,
        );
      }
      return { bytesRead: n };
    },
    async close() {
      /* in-memory handle */
    },
  };
}

const ROOT = "/tmp";

/** The acceptance-3 tree: two wave dirs, one lane each, plus failure-probe dirs. */
const TREE: FakeTree = {
  dirs: {
    [ROOT]: ["waveT", "waveU", "waveV", "waveW", "waveBroken", "notwave"],
    [`${ROOT}/waveT`]: ["t1.log", "gate-t1.log", "install-t1.log", "events.jsonl"],
    [`${ROOT}/waveU`]: ["u2.log", "gate-u2.log", "gate-u2-2.log", "events.jsonl"],
    [`${ROOT}/waveV`]: ["v3.log", "gate-v3.log", "events.jsonl"],
    [`${ROOT}/waveW`]: ["install-w.log"],
  },
  files: {
    [`${ROOT}/waveT/t1.log`]: "building...\nEXIT 0\n",
    [`${ROOT}/waveT/gate-t1.log`]:
      "Statements   : 100% ( 100/100 )\nBranches     : 98.5% ( 570/578 )\nFunctions    : 100% ( 20/20 )\nLines        : 99.9% ( 99/100 )\nGATE EXIT 0\n",
    [`${ROOT}/waveT/install-t1.log`]: "installing\n",
    [`${ROOT}/waveT/events.jsonl`]:
      '{"ts":"2026-09-07T16:55:43Z","wave":"T","lane":"t1","stage":"implement","event":"started"}\n',
    [`${ROOT}/waveU/events.jsonl`]:
      '{"ts":"2026-09-07T16:00:00Z","wave":"U","lane":"u2","stage":"implement","event":"started"}\n',
    [`${ROOT}/waveU/u2.log`]: "working silently\n",
    [`${ROOT}/waveU/gate-u2.log`]: "GATE EXIT 1\n",
    [`${ROOT}/waveU/gate-u2-2.log`]: "GATE EXIT 0\n",
    [`${ROOT}/waveV/events.jsonl`]:
      '{"ts":"2026-09-07T16:30:00Z","wave":"V","lane":"v3","stage":"implement","event":"started"}\n',
    [`${ROOT}/waveV/v3.log`]: "running\n",
    // gate-v3.log is listed but unreadable: the row stands on its event, minus the gate.
  },
  pgrep: async (pattern) => {
    if (pattern === "cf-t1(/|$| )") return 0;
    if (pattern === "cf-u2(/|$| )") return 2;
    if (pattern === "cf-v3(/|$| )") throw new Error("pgrep exploded");
    return 0;
  },
  gh: async (args) => {
    if ((args[0] === "api" && args[1].includes("pulls")) || args[0] === "pr") {
      return JSON.stringify([
        { number: 218, state: "OPEN", headRefName: "feat/t1", headRefOid: "oid1", repo: "m/r" },
        { number: 220, state: "OPEN", headRefName: "feat/v3", headRefOid: "oid3", repo: "m/r" },
        { number: 221, state: "OPEN", headRefName: "main", headRefOid: "oidX", repo: "m/r" },
        { number: 222, state: "DRAFTED", headRefName: "feat/t9", headRefOid: "oidY", repo: "m/r" },
        { number: 223, state: "MERGED", headRefName: "feat/w9", headRefOid: "oid9", repo: "m/r" },
        { number: 224, state: "CLOSED", headRefName: "feat/w8", headRefOid: "oid8", repo: "m/r" },
      ]);
    }
    if (args[0] === "api" && args[1] === "graphql") {
      // One read-only thread query for every open PR: 218 carries one
      // unresolved thread, 220 has none outstanding, 221 was left out of the
      // page on purpose — absent is the same answer as a failed read: unknown.
      return JSON.stringify({
        data: {
          search: {
            nodes: [
              {
                number: 218,
                reviewThreads: {
                  pageInfo: { hasNextPage: false },
                  nodes: [{ isResolved: false }, { isResolved: true }],
                },
              },
              {
                number: 220,
                reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [{ isResolved: true }] },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    }
    if (args[0] === "api") {
      if (args[1].includes("oid1")) {
        return JSON.stringify({
          total_count: 2,
          check_runs: [
            { name: "Build", status: "in_progress", conclusion: null },
            { name: "Lint", status: "completed", conclusion: "success" },
          ],
        });
      }
      throw new Error("gh api failed");
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  },
};

describe("collect", () => {
  test("a full tree yields both rows with coverage, liveness and the pending PR", async () => {
    const status = await collect(fakeDeps(TREE), ROOT, "2026-09-07T17:25:00Z");

    expect(status.generatedAt).toBe("2026-09-07T17:25:00Z");
    // W is the directory holding only `install-w.log`: no lane, no event, but
    // a discovered wave — a wave that has written nothing yet is a state an
    // operator needs to see, so it lists with no lanes, below every dated one.
    expect(status.waves.map((wave) => wave.id)).toEqual(["T", "U", "V", "W"]);

    const t1 = status.waves[0]?.lanes[0];
    expect(t1?.lane).toBe("t1");
    expect(t1?.reported).toMatchObject({ stage: "implement", event: "started" });
    expect(t1?.derived.alive).toBe(false);
    expect(t1?.derived.exit).toBe(0);
    expect(t1?.derived.log).toEqual({ bytes: 19, mtimeMs: 1_000, tail: "building...\nEXIT 0\n" });
    expect(t1?.derived.gate).toEqual({
      exit: 0,
      coverage: { statements: 100, branches: 98.5, functions: 100, lines: 99.9 },
    });
    expect(t1?.derived.pr).toEqual({
      number: 218,
      state: "open",
      checks: "pending",
      unresolvedThreads: 1,
    });

    const u2 = status.waves[1]?.lanes[0];
    expect(u2?.lane).toBe("u2");
    expect(u2?.reported).toMatchObject({ stage: "implement", event: "started" });
    expect(u2?.derived.alive).toBe(true);
    // Round 2 (gate-u2-2.log, EXIT 0) beats round 0 (gate-u2.log, EXIT 1).
    expect(u2?.derived.gate).toEqual({ exit: 0 });
    expect(u2?.derived.pr).toBeUndefined();

    const v3 = status.waves[2]?.lanes[0];
    expect(v3?.lane).toBe("v3");
    expect(v3?.derived.alive).toBe(false);
    expect(v3?.derived.gate).toBeUndefined();
    // H2: the check-runs read failed for oid3. That is *could not ask*, not
    // *nothing has run yet* — the two must not share a value (was: none).
    expect(v3?.derived.pr).toEqual({
      number: 220,
      state: "open",
      checks: "unknown",
      unresolvedThreads: 0,
    });
    expect(v3?.reported).toMatchObject({ stage: "implement", event: "started" });
  });

  test("a root of pipeline artefacts and no events yields no lanes — the 113-lanes regression", async () => {
    // The wave log root an orchestrator actually left behind (`/tmp/wave1`):
    // 442 files — gate rounds per stage, fix-runner transcripts, probe logs —
    // and no events for most of them. The page rendered 113 lanes, 102
    // vanished, because *any* `.log` was counted as one. The rule that
    // replaces the filename test: evidence creates a lane — an event naming
    // it — and a log only ever attaches to a lane the evidence already
    // names. Nothing on this list has an event, so none of it is a lane:
    // not the gate rounds, not the install transcripts, and not even logs
    // named after lanes that genuinely ran (`x16-fix2` and friends) — a
    // lane that emitted nothing is invisible, and invisible beats invented.
    const artifactNames = [
      "gate-x30-0143.log",
      "gate-ve5b1c-build.log",
      "gate-c4-lint:arch.log",
      "install-foo.log",
      "install-x30.log",
      "c4b-install.log",
      "q-x14-1.log",
      "q-x35.log",
      "q-hl5c-fix-1.log",
      "x15-fix.log",
      "x13-fix.log",
      "x16-fix2.log",
      "x26-fix.log",
      "hl5c-fix2.log",
      "s2fix.log",
      "s3fix2.log",
      "hl5e-runner.log",
      "hl5e-fix-runner.log",
      "oc-probe.log",
      "x16-tc.log",
      "weird name.log",
    ];
    const status = await collect(
      fakeDeps({
        dirs: {
          [ROOT]: ["waveD"],
          [`${ROOT}/waveD`]: [...artifactNames, "dispatch.out", "grok-metrics.tsv"],
        },
        files: Object.fromEntries(artifactNames.map((n) => [`${ROOT}/waveD/${n}`, "x\n"])),
      }),
      ROOT,
      "now",
    );
    // The wave is still listed — an absence of lanes is not an absence of a
    // wave — but no artefact bought a row.
    expect(status.waves.map((wave) => wave.id)).toEqual(["D"]);
    expect(status.waves[0]?.lanes).toEqual([]);
  });

  test("an event naming `x16-fix2` plus `x16-fix2.log` yields one lane with the log's liveness attached", async () => {
    // The case a name-based filter cannot get right: this repository has
    // genuinely run lanes named `x13-fix`, `x16-fix2`, `hl5c-fix2` — a
    // suffix rule drops them from the page while they run. Evidence, not
    // the filename, decides: the event makes the lane, the identically
    // named log attaches its bytes, tail and mtime to it.
    const status = await collect(
      fakeDeps({
        dirs: {
          [ROOT]: ["waveL"],
          [`${ROOT}/waveL`]: ["events.jsonl", "x16-fix2.log"],
        },
        files: {
          [`${ROOT}/waveL/events.jsonl`]:
            '{"ts":"2026-09-12T10:00:00Z","wave":"L","lane":"x16-fix2","stage":"implement","event":"started"}\n',
          [`${ROOT}/waveL/x16-fix2.log`]: "rerunning gate\n",
        },
        pgrep: async (pattern) => (pattern === "cf-x16-fix2(/|$| )" ? 1 : 0),
      }),
      ROOT,
      "now",
    );
    const lanes = status.waves[0]?.lanes ?? [];
    expect(lanes.map((lane) => lane.lane)).toEqual(["x16-fix2"]);
    expect(lanes[0]?.derived.alive).toBe(true);
    expect(lanes[0]?.derived.log).toEqual({
      bytes: 15,
      mtimeMs: 1_000,
      tail: "rerunning gate\n",
    });
  });

  test("an orphan log with no event is not a lane, not an error, and not on the page", async () => {
    // A runner that never emits leaves its log behind. It is not a lane —
    // nothing says it is — and its absence is not an error the collector
    // reports: the page simply says nothing about it.
    const status = await collect(
      fakeDeps({
        dirs: { [ROOT]: ["waveM"], [`${ROOT}/waveM`]: ["somelane.log"] },
        files: { [`${ROOT}/waveM/somelane.log`]: "quiet run\nEXIT 0\n" },
      }),
      ROOT,
      "now",
    );
    expect(status.waves.map((wave) => wave.id)).toEqual(["M"]);
    expect(status.waves[0]?.lanes).toEqual([]);
  });

  test("logs beside a reported lane are ignored unless the lane's own; the event still buys the row", async () => {
    // The same root, honestly: everything that is not the lane's own log is
    // skipped, and the one lane an event names gets exactly one row.
    // `l1-fix.log` is not `l1.log` — an attach is an exact-name join, never
    // a prefix or a pattern.
    const status = await collect(
      fakeDeps({
        dirs: {
          [ROOT]: ["waveD"],
          [`${ROOT}/waveD`]: ["events.jsonl", "gate-l1-build.log", "l1-fix.log", "q-l1-1.log"],
        },
        files: {
          [`${ROOT}/waveD/events.jsonl`]:
            '{"ts":"2026-09-12T10:00:00Z","wave":"D","lane":"l1","stage":"implement","event":"started"}\n',
        },
      }),
      ROOT,
      "now",
    );
    expect(status.waves[0]?.lanes.map((lane) => lane.lane)).toEqual(["l1"]);
  });

  test("three gate rounds pick the highest n, not the lexicographic last", async () => {
    const status = await collect(
      fakeDeps({
        dirs: {
          [ROOT]: ["waveR"],
          // Highest round listed first so a lexicographic pick still prefers
          // gate-r1.log (because "-" < ".") and the assertion cannot pass by luck.
          [`${ROOT}/waveR`]: ["r1.log", "gate-r1-3.log", "gate-r1-2.log", "gate-r1.log", "events.jsonl"],
        },
        files: {
          [`${ROOT}/waveR/events.jsonl`]:
            '{"ts":"2026-09-12T10:00:00Z","wave":"R","lane":"r1","stage":"gate","event":"started"}\n',
          [`${ROOT}/waveR/r1.log`]: "x\n",
          [`${ROOT}/waveR/gate-r1.log`]: "GATE EXIT 1\n",
          [`${ROOT}/waveR/gate-r1-2.log`]: "GATE EXIT 0\n",
          [`${ROOT}/waveR/gate-r1-3.log`]: "GATE EXIT 2\n",
        },
      }),
      ROOT,
      "now",
    );
    expect(status.waves[0]?.lanes[0]?.derived.gate).toEqual({ exit: 2 });
  });

  test("gate-s2.log is not the gate for lane s2i", async () => {
    const status = await collect(
      fakeDeps({
        dirs: {
          [ROOT]: ["waveS"],
          [`${ROOT}/waveS`]: ["s2.log", "s2i.log", "gate-s2.log", "gate-s2i.log", "events.jsonl"],
        },
        files: {
          [`${ROOT}/waveS/events.jsonl`]:
            '{"ts":"2026-09-12T10:00:00Z","wave":"S","lane":"s2","stage":"implement","event":"started"}\n' +
            '{"ts":"2026-09-12T10:00:00Z","wave":"S","lane":"s2i","stage":"implement","event":"started"}\n',
          [`${ROOT}/waveS/s2.log`]: "s2\n",
          [`${ROOT}/waveS/s2i.log`]: "s2i\n",
          [`${ROOT}/waveS/gate-s2.log`]: "GATE EXIT 0\n",
          [`${ROOT}/waveS/gate-s2i.log`]: "GATE EXIT 1\n",
        },
      }),
      ROOT,
      "now",
    );
    const lanes = Object.fromEntries(
      (status.waves[0]?.lanes ?? []).map((lane) => [lane.lane, lane.derived.gate]),
    );
    expect(lanes.s2).toEqual({ exit: 0 });
    expect(lanes.s2i).toEqual({ exit: 1 });
  });

  test("pgrep is anchored to the worktree path segment", async () => {
    const seen: string[] = [];
    await collect(
      fakeDeps({
        dirs: { [ROOT]: ["waveS"], [`${ROOT}/waveS`]: ["s2.log", "events.jsonl"] },
        files: {
          [`${ROOT}/waveS/events.jsonl`]:
            '{"ts":"2026-09-12T10:00:00Z","wave":"S","lane":"s2","stage":"implement","event":"started"}\n',
          [`${ROOT}/waveS/s2.log`]: "x\n",
        },
        pgrep: async (pattern) => {
          seen.push(pattern);
          return 0;
        },
      }),
      ROOT,
      "now",
    );
    expect(seen).toEqual(["cf-s2(/|$| )"]);
  });

  test("the liveness probe matches a process running in the worktree layout actually used, and fails if the convention changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-status-wt-"));
    const worktree = join(root, "cf-c5");
    const worktrees = [join(root, "campaign-foundry"), worktree];
    const pattern = pgrepPattern("c5", worktrees);
    const re = new RegExp(pattern);

    const liveProcessCmd = `cd ${worktree} && agy --model gemini-3.8-flash-high`;
    expect(re.test(liveProcessCmd)).toBe(true);

    const obsoleteCmd = `cd ${join(root, "wt-c5")} && agy`;
    expect(re.test(obsoleteCmd)).toBe(false);

    expect(pattern).toBe("cf-c5(/|$| )");
  });

  test("the liveness probe dynamically derives pattern from worktrees when layout changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-status-custom-"));
    const customWorktrees = [
      join(root, "campaign-foundry"),
      join(root, "custom-c5"),
    ];
    const pattern = pgrepPattern("c5", customWorktrees);
    expect(pattern).toBe("custom-c5(/|$| )");
    const re = new RegExp(pattern);
    expect(re.test(`cd ${customWorktrees[1]} && agy`)).toBe(true);
    expect(re.test(`cd ${join(root, "cf-c5")} && agy`)).toBe(false);

    // Deriving prefix for a lane not yet in worktree list
    const unlistedLanePattern = pgrepPattern("c6", customWorktrees);
    expect(unlistedLanePattern).toBe("custom-c6(/|$| )");
  });

  test("cached PR facts are reused and gh is not called", async () => {
    const gh = vi.fn(async () => {
      throw new Error("gh should not run on a cached collect");
    });
    const status = await collect(fakeDeps({ ...TREE, gh }), ROOT, "now", {
      facts: [{ number: 7, state: "open", checks: "pass", branchTail: "t1" }],
      skipped: 0,
    });
    expect(gh).not.toHaveBeenCalled();
    expect(status.waves[0]?.lanes[0]?.derived.pr).toEqual({ number: 7, state: "open", checks: "pass" });
    expect(status.waves[1]?.lanes[0]?.derived.pr).toBeUndefined();
  });

  test("a failing gh rejects with could not fetch, never an empty list", async () => {
    await expect(
      collect(
        fakeDeps({ ...TREE, gh: async () => { throw new Error("gh: no auth"); } }),
        ROOT,
        "now",
      ),
    ).rejects.toThrow("could not fetch PRs");
  });
  test("a corpus with unreadable rows is flagged, so no face can read it as no PR", async () => {
    // The page says "no PR" for a lane that joined nothing. With rows missing
    // that claim is not available: the lane's PR may be one of them.
    const gh = vi.fn(async () =>
      [
        JSON.stringify({ number: 7, state: "OPEN", headRefName: "feat/t1", headRefOid: "o1" }),
        "{",
      ].join("\n"),
    );
    const status = await collect(fakeDeps({ ...TREE, gh }), ROOT, "now");
    expect(status.prs).toEqual({ skipped: 1 });
    expect(status.waves[0]?.lanes[0]?.derived.pr?.number).toBe(7);
  });

  test("a corpus read whole carries no flag: an empty repository is an answer, not a gap", async () => {
    const status = await collect(fakeDeps({ ...TREE, gh: async () => "[]" }), ROOT, "now");
    expect(status.prs).toBeUndefined();
  });

  test("a cached corpus carries the gap it was read with", async () => {
    // A watcher refresh reuses the corpus; it is exactly as complete as the
    // read it came from, so the gap travels with it.
    const gh = vi.fn(async () => {
      throw new Error("gh should not run on a cached collect");
    });
    const status = await collect(fakeDeps({ ...TREE, gh }), ROOT, "now", { facts: [], skipped: 3 });
    expect(status.prs).toEqual({ skipped: 3 });
  });


  test("waves come out newest-first by their lanes' log mtimes, not in the directories' lexicographic order", async () => {
    // Directory names sort wave-10 < wave-7 < wave-8 < wave-9; the lane mtimes
    // tell a different story — 9 is the live wave, 10 is older, and 7 and 8
    // have unreadable logs, so nothing dates them at all. Undated waves must
    // sink below every dated one and keep the first-seen (lexicographic)
    // order among themselves.
    const mtimes: Record<string, number> = {
      [`${ROOT}/wave-9/a.log`]: 3_000,
      [`${ROOT}/wave-9/b.log`]: 5_000,
      [`${ROOT}/wave-10/c.log`]: 2_000,
      [`${ROOT}/wave-10/d.log`]: 1_000,
    };
    const files: Record<string, string> = Object.fromEntries(
      Object.keys(mtimes).map((path) => [path, "x\n"]),
    );
    for (const [dir, laneNames] of [
      ["wave-9", ["a", "b"]],
      ["wave-10", ["c", "d"]],
      ["wave-8", ["e"]],
      ["wave-7", ["f"]],
    ] as const) {
      files[`${ROOT}/${dir}/events.jsonl`] = laneNames
        .map(
          (lane) =>
            `{"ts":"2026-09-07T16:00:00Z","wave":"${dir.slice(5)}","lane":"${lane}","stage":"implement","event":"started"}\n`,
        )
        .join("");
    }
    const base = fakeDeps({
      dirs: {
        [ROOT]: ["wave-9", "wave-10", "wave-8", "wave-7"],
        [`${ROOT}/wave-9`]: ["a.log", "b.log", "events.jsonl"],
        [`${ROOT}/wave-10`]: ["c.log", "d.log", "events.jsonl"],
        [`${ROOT}/wave-8`]: ["e.log", "events.jsonl"],
        [`${ROOT}/wave-7`]: ["f.log", "events.jsonl"],
      },
      files,
    });
    const deps: CollectDeps = {
      ...base,
      open: async (path) => {
        const text = files[path];
        if (text === undefined) throw new Error(`ENOENT: open ${path}`);
        return memoryHandle(Buffer.from(text, "utf8"), mtimes[path]);
      },
    };
    const status = await collect(deps, ROOT, "now");
    expect(status.waves.map((wave) => wave.id)).toEqual(["9", "10", "7", "8"]);
    expect(status.waves[0]?.lanes.map((lane) => lane.lane)).toEqual(["a", "b"]);
  });

  test("a newer wave whose lanes barely report still leads an older wave with full events", async () => {
    // The live-vs-reported split that used to decide wave order by feed:
    // mergeStatus created every evented wave's group before any
    // observation-only wave's, so wave 8 — which reported a merge — led wave
    // 9 — which was live — whatever the collector said about recency.
    // Ordering may not depend on how much a wave happens to have said.
    const mtimes: Record<string, number> = {
      [`${ROOT}/wave-8/a.log`]: 1_000,
      [`${ROOT}/wave-9/b.log`]: 5_000,
    };
    const files: Record<string, string> = {
      [`${ROOT}/wave-8/a.log`]: "settled long ago\n",
      [`${ROOT}/wave-8/events.jsonl`]:
        '{"ts":"2026-09-07T16:55:43Z","wave":"8","lane":"a","stage":"merge","event":"settled","pr":301}\n',
      [`${ROOT}/wave-9/b.log`]: "building right now\n",
      [`${ROOT}/wave-9/events.jsonl`]:
        '{"ts":"2026-09-08T10:00:00Z","wave":"9","lane":"b","stage":"implement","event":"started"}\n',
    };
    const base = fakeDeps({
      dirs: {
        [ROOT]: ["wave-8", "wave-9"],
        [`${ROOT}/wave-8`]: ["a.log", "events.jsonl"],
        [`${ROOT}/wave-9`]: ["b.log", "events.jsonl"],
      },
      files,
    });
    const deps: CollectDeps = {
      ...base,
      open: async (path) => {
        const text = files[path];
        if (text === undefined) throw new Error(`ENOENT: open ${path}`);
        return memoryHandle(Buffer.from(text, "utf8"), mtimes[path] ?? 1_000);
      },
    };
    const status = await collect(deps, ROOT, "now");

    expect(status.waves.map((wave) => wave.id)).toEqual(["9", "8"]);
    // Ordering is not paid for with data: the older wave keeps its report.
    expect(status.waves[1]?.lanes[0]?.reported).toMatchObject({
      stage: "merge",
      event: "settled",
      pr: 301,
    });
  });

  test("a wave directory holding nothing yet appears with no lanes, and sinks below dated waves", async () => {
    // A dispatched wave whose dispatcher has not written a lane log or an
    // event is the state an operator most wants to see. It used to be absent
    // from the result entirely — invisible is worse than quiet.
    const status = await collect(
      fakeDeps({
        dirs: {
          [ROOT]: ["wave-10", "wave-9"],
          [`${ROOT}/wave-10`]: [],
          [`${ROOT}/wave-9`]: ["a.log", "events.jsonl"],
        },
        files: {
          [`${ROOT}/wave-9/a.log`]: "x\n",
          [`${ROOT}/wave-9/events.jsonl`]:
            '{"ts":"2026-09-07T16:00:00Z","wave":"9","lane":"a","stage":"implement","event":"started"}\n',
        },
      }),
      ROOT,
      "now",
    );
    expect(status.waves.map((wave) => wave.id)).toEqual(["9", "10"]);
    expect(status.waves[1]?.lanes).toEqual([]);
  });

  test("malformed gh output is a flagged gap, not a crash and not a claim of no PRs", async () => {
    // The page says "no PR" for a lane that joined nothing. With a row that
    // could not be read, that claim is not available to it.
    const status = await collect(
      fakeDeps({ ...TREE, gh: async () => "not json" }),
      ROOT,
      "now",
    );
    expect(status.waves[0]?.lanes[0]?.derived.pr).toBeUndefined();
    expect(status.prs).toEqual({ skipped: 1 });
  });

  test("wrong-shape gh JSON never throws, and every unreadable row is counted", async () => {
    const bodies = [
      "{}",
      "null",
      "1",
      '"open"',
      "[1]",
      "[null]",
      JSON.stringify([{ state: "OPEN", headRefName: "feat/t1", headRefOid: "oid1" }]),
      JSON.stringify([{ number: "218", state: "OPEN", headRefName: "feat/t1", headRefOid: "oid1" }]),
      JSON.stringify([{ number: 218, state: 1, headRefName: "feat/t1", headRefOid: "oid1" }]),
      JSON.stringify([{ number: 218, state: "OPEN", headRefName: 1, headRefOid: "oid1" }]),
      JSON.stringify([{ number: 218, state: "OPEN", headRefName: "feat/t1", headRefOid: 1 }]),
    ];
    for (const body of bodies) {
      const status = await collect(fakeDeps({ ...TREE, gh: async () => body }), ROOT, "now");
      for (const wave of status.waves) {
        for (const lane of wave.lanes) {
          expect({ body, pr: lane.derived.pr }).toEqual({ body, pr: undefined });
        }
      }
      // A row that came back and could not be read. It never throws and never
      // empties the corpus — it is counted, so the page knows the read was
      // short instead of reading the empty corpus as no pull requests.
      expect({ body, skipped: status.prs?.skipped }).toEqual({ body, skipped: 1 });
    }
  });

  test("a row that reads keeps its lane's PR with an unreadable row beside it", async () => {
    // The defect this lane was opened on: one malformed entry used to reject
    // the batch, and the caller turned that into an empty corpus — a single
    // bad row rendering as a repository with no pull requests at all.
    const body = JSON.stringify([
      { number: 218, state: "OPEN", headRefName: "feat/t1", headRefOid: "oid1" },
      { number: 219 },
    ]);
    const status = await collect(fakeDeps({ ...TREE, gh: async () => body }), ROOT, "now");
    expect(status.waves[0]?.lanes[0]?.derived.pr?.number).toBe(218);
    expect(status.prs).toEqual({ skipped: 1 });
  });

  test("a log larger than the tail is read from the end, not whole", async () => {
    const big = `${"x".repeat(2 * 1024 * 1024)}EXIT 0\n`;
    const logPath = `${ROOT}/waveB/b1.log`;
    const inner = fakeDeps({
      dirs: { [ROOT]: ["waveB"], [`${ROOT}/waveB`]: ["b1.log", "events.jsonl"] },
      files: {
        [logPath]: big,
        [`${ROOT}/waveB/events.jsonl`]:
          '{"ts":"2026-09-12T10:00:00Z","wave":"B","lane":"b1","stage":"implement","event":"started"}\n',
      },
    });
    let bytesRead = 0;
    const deps: CollectDeps = {
      ...inner,
      readFile: async (path) => {
        const text = await inner.readFile(path);
        if (path === logPath) bytesRead += Buffer.byteLength(text);
        return text;
      },
      open: async (path) => {
        const fh = await inner.open(path);
        return {
          stat: () => fh.stat(),
          read: async (buffer, offset, length, position) => {
            const result = await fh.read(buffer, offset, length, position);
            if (path === logPath) bytesRead += result.bytesRead;
            return result;
          },
          close: () => fh.close(),
        };
      },
    };
    const status = await collect(deps, ROOT, "now");
    const log = status.waves[0]?.lanes[0]?.derived.log;
    expect(log?.bytes).toBe(Buffer.byteLength(big));
    expect(log?.tail).toBe(big.slice(-LOG_TAIL_BYTES));
    expect(bytesRead).toBe(LOG_TAIL_BYTES);
    expect(bytesRead).toBeLessThan(Buffer.byteLength(big));
  });

  test("an unreadable wave-log root is an empty status", async () => {
    const status = await collect(fakeDeps({}), "/does-not-exist", "now");
    expect(status).toEqual({
      generatedAt: "now",
      waves: [],
      backlog: { state: "absent" },
    });
  });

  test("a lane log that vanishes between listing and reading drops the log, keeps the row", async () => {
    // The row stands on the event; the log was only ever an attachment.
    const status = await collect(
      fakeDeps({
        dirs: { [ROOT]: ["waveX"], [`${ROOT}/waveX`]: ["x1.log", "events.jsonl"] },
        files: {
          [`${ROOT}/waveX/events.jsonl`]:
            '{"ts":"2026-09-12T10:00:00Z","wave":"X","lane":"x1","stage":"implement","event":"started"}\n',
        },
      }),
      ROOT,
      "now",
    );
    const x1 = status.waves[0]?.lanes[0];
    expect(x1?.lane).toBe("x1");
    expect(x1?.derived.log).toBeUndefined();
    expect(x1?.derived.alive).toBe(false);
  });

  test("exports durable and legacy roots", () => {
    expect(WAVE_LOG_ROOT).toMatch(/\.waves$/);
    expect(LEGACY_WAVE_LOG_ROOT).toBe("/tmp");
  });

  test("resolveScanRoots deduplicates and resolves default legacy roots", () => {
    expect(resolveScanRoots(WAVE_LOG_ROOT)).toEqual([WAVE_LOG_ROOT, LEGACY_WAVE_LOG_ROOT]);
    expect(resolveScanRoots(WAVE_LOG_ROOT, [LEGACY_WAVE_LOG_ROOT])).toEqual([
      WAVE_LOG_ROOT,
      LEGACY_WAVE_LOG_ROOT,
    ]);
    expect(resolveScanRoots("/custom")).toEqual(["/custom"]);
    expect(resolveScanRoots("/custom", ["/legacy", "/custom"])).toEqual(["/custom", "/legacy"]);
  });

  test("default legacy roots are scanned when root is WAVE_LOG_ROOT and legacyRoots is omitted", async () => {
    const status = await collect(
      fakeDeps({
        dirs: {
          [WAVE_LOG_ROOT]: ["waveDurable"],
          [`${WAVE_LOG_ROOT}/waveDurable`]: ["d1.log", "events.jsonl"],
          [LEGACY_WAVE_LOG_ROOT]: ["waveLegacy"],
          [`${LEGACY_WAVE_LOG_ROOT}/waveLegacy`]: ["l1.log", "events.jsonl"],
        },
        files: {
          [`${WAVE_LOG_ROOT}/waveDurable/events.jsonl`]:
            '{"ts":"2026-09-12T10:00:00Z","wave":"Durable","lane":"d1","stage":"implement","event":"started"}\n',
          [`${WAVE_LOG_ROOT}/waveDurable/d1.log`]: "durable\nEXIT 0\n",
          [`${LEGACY_WAVE_LOG_ROOT}/waveLegacy/events.jsonl`]:
            '{"ts":"2026-09-12T10:00:00Z","wave":"Legacy","lane":"l1","stage":"implement","event":"started"}\n',
          [`${LEGACY_WAVE_LOG_ROOT}/waveLegacy/l1.log`]: "legacy\nEXIT 0\n",
        },
      }),
      WAVE_LOG_ROOT,
      "now",
    );
    expect(status.waves.map((w) => w.id)).toEqual(["Durable", "Legacy"]);
  });

  test("collects waves from both root and legacy roots when configured", async () => {
    const status = await collect(
      fakeDeps({
        dirs: {
          "/durable": ["waveDurable"],
          "/durable/waveDurable": ["d1.log", "events.jsonl"],
          "/tmp": ["waveLegacy"],
          "/tmp/waveLegacy": ["l1.log", "events.jsonl"],
        },
        files: {
          "/durable/waveDurable/events.jsonl":
            '{"ts":"2026-09-12T10:00:00Z","wave":"Durable","lane":"d1","stage":"implement","event":"started"}\n',
          "/durable/waveDurable/d1.log": "durable\nEXIT 0\n",
          "/tmp/waveLegacy/events.jsonl":
            '{"ts":"2026-09-12T10:00:00Z","wave":"Legacy","lane":"l1","stage":"implement","event":"started"}\n',
          "/tmp/waveLegacy/l1.log": "legacy\nEXIT 0\n",
        },
      }),
      "/durable",
      "now",
      undefined,
      ["/tmp"],
    );
    expect(status.waves.map((w) => w.id)).toEqual(["Durable", "Legacy"]);
  });

  test("primary root takes precedence when a wave exists in both root and legacy root", async () => {
    const status = await collect(
      fakeDeps({
        dirs: {
          "/durable": ["waveShared"],
          "/durable/waveShared": ["lane1.log", "events.jsonl"],
          "/tmp": ["waveShared"],
          "/tmp/waveShared": ["lane2.log", "events.jsonl"],
        },
        files: {
          "/durable/waveShared/events.jsonl":
            '{"ts":"2026-09-12T10:00:00Z","wave":"Shared","lane":"lane1","stage":"implement","event":"started"}\n',
          "/durable/waveShared/lane1.log": "from durable\nEXIT 0\n",
          "/tmp/waveShared/events.jsonl":
            '{"ts":"2026-09-12T10:00:00Z","wave":"Shared","lane":"lane2","stage":"implement","event":"started"}\n',
          "/tmp/waveShared/lane2.log": "from legacy\nEXIT 0\n",
        },
      }),
      "/durable",
      "now",
      undefined,
      ["/tmp"],
    );
    expect(status.waves.map((w) => w.id)).toEqual(["Shared"]);
    expect(status.waves[0]?.lanes.map((l) => l.lane)).toEqual(["lane1"]);
  });

  test("unreadable primary root recovers in-flight waves from legacy root", async () => {
    const status = await collect(
      fakeDeps({
        dirs: {
          "/tmp": ["waveLegacyOnly"],
          "/tmp/waveLegacyOnly": ["l1.log", "events.jsonl"],
        },
        files: {
          "/tmp/waveLegacyOnly/events.jsonl":
            '{"ts":"2026-09-12T10:00:00Z","wave":"LegacyOnly","lane":"l1","stage":"implement","event":"started"}\n',
          "/tmp/waveLegacyOnly/l1.log": "legacy data\nEXIT 0\n",
        },
      }),
      "/unreadable-primary",
      "now",
      undefined,
      ["/tmp"],
    );
    expect(status.waves.map((w) => w.id)).toEqual(["LegacyOnly"]);
  });

  test("skips duplicate legacy roots if legacy root equals primary root", async () => {
    let readdirCount = 0;
    const deps = fakeDeps({
      dirs: {
        "/same": ["waveOne"],
        "/same/waveOne": ["l1.log"],
      },
      files: {
        "/same/waveOne/l1.log": "data\nEXIT 0\n",
      },
    });
    const countingDeps = {
      ...deps,
      readdir: async (dir: string) => {
        if (dir === "/same") readdirCount++;
        return deps.readdir(dir);
      },
    };
    const status = await collect(countingDeps, "/same", "now", undefined, ["/same"]);
    expect(status.waves.map((w) => w.id)).toEqual(["One"]);
    expect(readdirCount).toBe(1);
  });
});

describe("prFacts", () => {
  function prListDeps(list: unknown, checkRuns = async (): Promise<string> => "not json"): CollectDeps {
    return fakeDeps({
      gh: async (args) => {
        if ((args[0] === "api" && args[1].includes("pulls")) || args[0] === "pr") {
          return typeof list === "string" ? list : JSON.stringify(list);
        }
        return checkRuns();
      },
    });
  }

  test("a gh failure rejects with could not fetch, never an empty list", async () => {
    const gh = vi.fn(async () => {
      throw new Error("unknown flag: --page");
    });
    await expect(prFacts(fakeDeps({ gh }))).rejects.toThrow("could not fetch PRs");
  });

  test("a non-Error gh rejection surfaces its string value", async () => {
    const gh = vi.fn(async () => {
      throw "network timeout";
    });
    await expect(prFacts(fakeDeps({ gh }))).rejects.toThrow("could not fetch PRs: network timeout");
  });

  test("an empty gh response yields no facts and no gap", async () => {
    // Nothing to fetch is an answer: a repository with no pull requests. It is
    // the one case an empty corpus is allowed to mean what it says.
    const corpus = await prFacts(fakeDeps({ gh: async () => "   " }));
    expect(corpus).toEqual({ facts: [], skipped: 0 });
  });

  test("one malformed row is skipped and counted, never allowed to empty the corpus", async () => {
    // The fault this lane was opened on: a single unreadable row used to
    // reject the whole batch, and the caller turned that into an empty
    // corpus — one truncated row rendered as a repository with no PRs.
    const rows = [
      JSON.stringify({ number: 1000, state: "OPEN", headRefName: "feat/lane-0", headRefOid: "o0" }),
      JSON.stringify({ number: 1001, state: "OPEN", headRefName: "feat/lane-1", headRefOid: "o1" }).slice(0, 24),
      JSON.stringify({ number: 1002, state: "OPEN", headRefName: "feat/lane-2", headRefOid: "o2" }),
    ];
    const corpus = await prFacts(fakeDeps({ gh: async () => rows.join("\n") }));
    expect(corpus.skipped).toBe(1);
    expect(corpus.facts.map((fact) => fact.number)).toEqual([1000, 1002]);
  });

  test("a row the projection left short is skipped and counted, and its neighbours survive", async () => {
    const corpus = await prFacts(
      prListDeps([
        { number: 300, state: "OPEN", headRefName: "feat/t1", headRefOid: "whole" },
        { number: 301, state: "OPEN", headRefName: "feat/t2" },
      ]),
    );
    expect(corpus.skipped).toBe(1);
    expect(corpus.facts.map((fact) => fact.number)).toEqual([300]);
  });

  test("output that came back but read to nothing is an empty corpus with a gap, not a clean zero", async () => {
    // `gh` answers "no pull requests" with no output at all, so rows it did
    // return that nothing can parse are a read that came up short. The count
    // is the difference: the page may not read this as no pull requests.
    const corpus = await prFacts(fakeDeps({ gh: async () => "not json" }));
    expect(corpus).toEqual({ facts: [], skipped: 1 });
  });

  test("a listing of nothing but unreadable rows counts every one of them", async () => {
    const corpus = await prFacts(fakeDeps({ gh: async () => '["a","b"]' }));
    expect(corpus).toEqual({ facts: [], skipped: 2 });
  });

  test("asks gh api for pulls with pagination and jq projection", async () => {
    const gh = vi.fn(async () => "[]");
    await prFacts(fakeDeps({ gh }));
    expect(gh).toHaveBeenCalledWith([
      "api",
      "repos/{owner}/{repo}/pulls?state=all&per_page=100",
      "--paginate",
      "--jq",
      PR_PULLS_JQ,
    ]);
  });

  test("parses paginated PR stream into facts", async () => {
    const lines = [
      JSON.stringify({ number: 1000, state: "OPEN", headRefName: "feat/lane-0", headRefOid: "o0" }),
      JSON.stringify({ number: 1, state: "MERGED", headRefName: "feat/oldest", headRefOid: "oz" }),
    ].join("\n");
    const gh = vi.fn(async () => lines);
    const { facts } = await prFacts(fakeDeps({ gh }));
    expect(facts).toHaveLength(2);
    expect(facts[0]).toEqual({
      number: 1000,
      state: "open",
      // No repo survived the projection, so the thread query could not run,
      // and the default check-runs stub answers "not json": both are
      // *could not ask*, never the old `none` that meant four things.
      checks: "unknown",
      unresolvedThreads: "unknown",
      branchTail: "lane-0",
    });
    expect(facts[1]).toEqual({
      number: 1,
      state: "merged",
      checks: "unknown",
      branchTail: "oldest",
    });
  });

  test("a check-runs fetch is scoped to the heads a lane claims, not every open PR", async () => {
    const gh = vi.fn(async (args: readonly string[]) => {
      if ((args[0] === "api" && args[1].includes("pulls")) || args[0] === "pr") {
        return JSON.stringify([
          { number: 218, state: "OPEN", headRefName: "feat/t1", headRefOid: "exact" },
          { number: 217, state: "OPEN", headRefName: "feat/t1-descendant", headRefOid: "desc" },
          { number: 219, state: "OPEN", headRefName: "feat/unrelated", headRefOid: "theirs" },
        ]);
      }
      return "not json";
    });
    const { facts } = await prFacts(fakeDeps({ gh }), {
      lanes: new Set(["t1"]),
      reportedPrs: new Set<number>(),
    });
    // All three stay listed; only exact/descendant lane matches cost an api call.
    expect(facts.map((fact) => fact.number)).toEqual([218, 217, 219]);
    const apiArgs = gh.mock.calls
      .map((call) => call[0] as readonly string[])
      .filter((args) => args[0] === "api" && args[1].includes("check-runs"))
      .map((args) => args[1] ?? "");
    expect(apiArgs).toHaveLength(2);
    expect(apiArgs.join(" ")).toContain("exact");
    expect(apiArgs.join(" ")).toContain("desc");
  });

  test("a reported pr claims its open head even when no branch matches", async () => {
    const gh = vi.fn(async (args: readonly string[]) => {
      if ((args[0] === "api" && args[1].includes("pulls")) || args[0] === "pr") {
        return JSON.stringify([
          { number: 218, state: "OPEN", headRefName: "feat/reworded-slug", headRefOid: "mine" },
        ]);
      }
      return "not json";
    });
    await prFacts(fakeDeps({ gh }), { lanes: new Set(["t1"]), reportedPrs: new Set([218]) });
    expect(gh).toHaveBeenCalledTimes(2);
  });

  test("every PR becomes a fact with its case-folded branch tail, slash or no slash", async () => {
    const { facts } = await prFacts(
      prListDeps([
        { number: 285, state: "MERGED", headRefName: "fix/H2-hit-testing", headRefOid: "o1" },
        { number: 221, state: "CLOSED", headRefName: "main", headRefOid: "o2" },
        { number: 222, state: "DRAFTED", headRefName: "feat/t9", headRefOid: "o3" },
      ]),
    );
    expect(facts).toEqual([
      { number: 285, state: "merged", checks: "unknown", branchTail: "h2-hit-testing" },
      { number: 221, state: "closed", checks: "unknown", branchTail: "main" },
    ]);
  });

  test("open PRs carry their checks; a check-runs failure is unknown, not none", async () => {
    const { facts } = await prFacts(
      prListDeps(
        [
          { number: 218, state: "OPEN", headRefName: "feat/t1", headRefOid: "good" },
          { number: 220, state: "OPEN", headRefName: "feat/v3", headRefOid: "bad" },
        ],
        async () => {
          throw new Error("gh api failed");
        },
      ),
    );
    // 218's check-runs read *throws*: could not ask, which is not the same
    // fact as "no Build check has run" (none). The default that used to cover
    // both made a failed read masquerade as a measurement.
    expect(facts.map((fact) => fact.checks)).toEqual(["unknown", "unknown"]);
  });
});

describe("thread state", () => {
  function threadDeps(opts: {
    list?: unknown;
    threads?: (args: readonly string[], page: number) => string;
    checkRuns?: string;
  }): { deps: CollectDeps; calls: readonly (readonly string[])[] } {
    const calls: string[][] = [];
    let threadPage = 0;
    const deps = fakeDeps({
      gh: async (args) => {
        calls.push([...args]);
        if (args[0] === "api" && args[1] === "graphql") {
          threadPage += 1;
          if (opts.threads === undefined) throw new Error("graphql should not run");
          return opts.threads(args, threadPage);
        }
        if ((args[0] === "api" && args[1].includes("pulls")) || args[0] === "pr") {
          return JSON.stringify(opts.list ?? []);
        }
        return opts.checkRuns ?? '{"check_runs": []}';
      },
    });
    return { deps, calls };
  }
  const openRow = (n: number, head = `feat/lane-${n}`) => ({
    number: n,
    state: "OPEN",
    headRefName: head,
    headRefOid: `o${n}`,
    repo: "m/r",
  });
  const mergedRow = (n: number, head = `feat/lane-${n}`) => ({
    number: n,
    state: "MERGED",
    headRefName: head,
    headRefOid: `o${n}`,
    repo: "m/r",
  });
  const prNode = (number: number, resolved: boolean[], truncated = false) => ({
    number,
    reviewThreads: {
      pageInfo: { hasNextPage: truncated },
      nodes: resolved.map((isResolved) => ({ isResolved })),
    },
  });
  const searchPage = (nodes: readonly unknown[], endCursor: string | null = null) =>
    JSON.stringify({
      data: {
        search: { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } },
      },
    });

  test("thread state for every open PR arrives in ONE query — never a call per PR", async () => {
    const { deps, calls } = threadDeps({
      list: [openRow(218), openRow(219), openRow(222), mergedRow(223)],
      threads: () => searchPage([prNode(218, [false, true]), prNode(219, [true])]),
    });
    const { facts } = await prFacts(deps, {
      lanes: new Set(["lane-218", "lane-219"]),
      reportedPrs: new Set<number>(),
    });
    const threadCalls = calls.filter((args) => args[0] === "api" && args[1] === "graphql");
    expect(threadCalls).toHaveLength(1);
    const byNumber = new Map(facts.map((fact) => [fact.number, fact]));
    // Claimed, answered, unresolved — the count, never the prose.
    expect(byNumber.get(218)?.unresolvedThreads).toBe(1);
    // Claimed, answered, nothing outstanding — a DIFFERENT value from unknown.
    expect(byNumber.get(219)?.unresolvedThreads).toBe(0);
    // Open but unclaimed for checks: the single thread query still answered
    // for it — absent from the page, so honestly unknown, never silently zero.
    expect(byNumber.get(222)?.unresolvedThreads).toBe("unknown");
    // Merged: threads were never a question for it. No field, not a fake zero.
    expect(byNumber.get(223)?.unresolvedThreads).toBeUndefined();
  });

  test("the thread query is a read-only graphql search over open PRs of the listed repo", async () => {
    const { deps, calls } = threadDeps({
      list: [openRow(218)],
      threads: () => searchPage([prNode(218, [])]),
    });
    await prFacts(deps);
    const args = calls.find((call) => call[0] === "api" && call[1] === "graphql")!;
    const joined = args.join(" ");
    expect(joined).toContain("repo:m/r is:pr is:open");
    expect(joined).toContain("reviewThreads");
    // Read-only: the query asks for nothing that mutates a thread. (`isResolved`
    // is a field read, not the ResolveReviewThread mutation — hence the word
    // boundary and the named mutations rather than a bare /resolve/.)
    expect(joined).not.toMatch(
      /\bmutation\b|resolveReviewThread|submitReview|updatePullRequest|addPullRequestReview|createReaction/i,
    );
  });

  test("a thread query that fails leaves every open PR unknown and the facts intact", async () => {
    const { deps } = threadDeps({
      list: [openRow(218), mergedRow(223)],
      threads: () => {
        throw new Error("graphql: could not resolve host");
      },
    });
    const { facts } = await prFacts(deps);
    expect(facts.find((f) => f.number === 218)).toMatchObject({
      checks: "none",
      unresolvedThreads: "unknown",
    });
    expect(facts.find((f) => f.number === 223)?.unresolvedThreads).toBeUndefined();
  });

  test("a thread response nothing can read is unknown, not zero, and not a throw", async () => {
    const bodies = [
      "not json",
      "{}",
      "[]",
      '{"data":null}',
      '{"data":{"search":5}}',
      '{"data":{"search":{}}}',
      '{"data":{"search":{"nodes":{},"pageInfo":{}}}}',
      '{"data":{"search":{"nodes":[],"pageInfo":null}}}',
    ];
    for (const body of bodies) {
      const { deps } = threadDeps({ list: [openRow(218)], threads: () => body });
      const { facts } = await prFacts(deps);
      expect({ body, threads: facts[0]?.unresolvedThreads }).toEqual({
        body,
        threads: "unknown",
      });
    }
  });

  test("a PR whose thread page was truncated is unknown — a partial count is not a count", async () => {
    const { deps } = threadDeps({
      list: [openRow(218), openRow(219)],
      threads: () => searchPage([prNode(218, [false], true), prNode(219, [false, false])]),
    });
    const { facts } = await prFacts(deps);
    const byNumber = new Map(facts.map((f) => [f.number, f]));
    expect(byNumber.get(218)?.unresolvedThreads).toBe("unknown");
    expect(byNumber.get(219)?.unresolvedThreads).toBe(2);
  });

  test("a full thread page continues by cursor — still never a per-PR call", async () => {
    const { deps, calls } = threadDeps({
      list: [openRow(218), openRow(219)],
      threads: (_args, page) =>
        page === 1
          ? searchPage([prNode(218, [false])], "cur1")
          : searchPage([prNode(219, [true, true])]),
    });
    const { facts } = await prFacts(deps);
    const byNumber = new Map(facts.map((f) => [f.number, f]));
    expect(byNumber.get(218)?.unresolvedThreads).toBe(1);
    expect(byNumber.get(219)?.unresolvedThreads).toBe(0);
    const threadCalls = calls.filter((args) => args[0] === "api" && args[1] === "graphql");
    expect(threadCalls).toHaveLength(2);
    expect(threadCalls[1]?.join(" ")).toContain("after=cur1");
  });

  test("a claimed next page with no cursor ends the walk rather than spinning", async () => {
    const { deps, calls } = threadDeps({
      list: [openRow(218)],
      threads: () =>
        '{"data":{"search":{"nodes":[],"pageInfo":{"hasNextPage":true,"endCursor":null}}}}',
    });
    const { facts } = await prFacts(deps);
    expect(facts[0]?.unresolvedThreads).toBe("unknown");
    expect(calls.filter((args) => args[1] === "graphql")).toHaveLength(1);
  });

  // Finding 3: a response that hands back the marker it was just sent has
  // not advanced. Following it anyway issues `gh` calls forever — startup or
  // a refresh never completes and every scheduled refresh behind it is stuck.
  // The walk must stop, and the truncation must read as the gap it is: every
  // open the walk never reached is "unknown", never a silent zero.
  test("a response repeating the page marker stops the walk — bounded calls, unread opens unknown", async () => {
    const { deps, calls } = threadDeps({
      list: [openRow(218), openRow(219)],
      threads: (_args, page) => {
        // A correct walk is over after the second page answers; a third
        // page means the loop did not stop, and this throws rather than
        // letting a broken walk spin the runner dry.
        if (page > 2) throw new Error("the walk did not stop at a repeated cursor");
        return searchPage([prNode(218, [false])], "cur1");
      },
    });
    const { facts } = await prFacts(deps);
    const threadCalls = calls.filter((args) => args[0] === "api" && args[1] === "graphql");
    expect(threadCalls).toHaveLength(2);
    expect(threadCalls[1]?.join(" ")).toContain("after=cur1");
    const byNumber = new Map(facts.map((f) => [f.number, f]));
    // 218's own thread list came back complete, so its count stands; 219
    // never arrived in any readable page — the truncation's answer, as for a
    // truncated thread page, is unknown.
    expect(byNumber.get(218)?.unresolvedThreads).toBe(1);
    expect(byNumber.get(219)?.unresolvedThreads).toBe("unknown");
  });

  // Finding 4: absence of a boolean is not `false`. A `reviewThreads` page
  // whose `hasNextPage` is missing or not a boolean never answered "this is
  // the whole thread list", and counting it as one turns an unread thread
  // state into a zero — which, under green checks, is `laneState` calling a
  // lane it could not read `ready`. (The no-count-lands-on-ready half is the
  // existing "green checks with an unmeasured thread state is unknown, not
  // ready" test on `laneState`: unknown in, unknown out.)
  test("a reviewThreads page without a boolean hasNextPage is unknown, never a completed zero", async () => {
    const { deps } = threadDeps({
      list: [openRow(218), openRow(219), openRow(222)],
      threads: () =>
        '{"data":{"search":{"nodes":[' +
        '{"number":218,"reviewThreads":{"nodes":[],"pageInfo":{}}},' +
        '{"number":219,"reviewThreads":{"nodes":[{"isResolved":true}],"pageInfo":{"hasNextPage":"no"}}},' +
        '{"number":222,"reviewThreads":{"nodes":[{"isResolved":false}],"pageInfo":{"hasNextPage":false}}}' +
        '],"pageInfo":{"hasNextPage":false}}}}',
    });
    const { facts } = await prFacts(deps);
    const byNumber = new Map(facts.map((f) => [f.number, f]));
    // The brief's payload: `{nodes: [], pageInfo: {}}` used to become zero
    // threads. A missing flag and a non-boolean one are the same silence.
    expect(byNumber.get(218)?.unresolvedThreads).toBe("unknown");
    expect(byNumber.get(219)?.unresolvedThreads).toBe("unknown");
    // A real boolean `false` is an answered page: the count stands, and the
    // measured zero stays a measurement — only the gap changes sides.
    expect(byNumber.get(222)?.unresolvedThreads).toBe(1);
  });

  test("a malformed search page marks nothing read, and every open PR stays unknown", async () => {
    const { deps } = threadDeps({
      list: [openRow(218)],
      threads: () => '{"data":{"search":{"nodes":[{"number":"218","reviewThreads":{}}],"pageInfo":{}}}}',
    });
    const { facts } = await prFacts(deps);
    expect(facts[0]?.unresolvedThreads).toBe("unknown");
  });

  test("garbage rows ride along with good ones: non-PR and unreadable nodes are skipped, not fatal", async () => {
    const { deps } = threadDeps({
      list: [openRow(218), openRow(219), openRow(222), openRow(223)],
      threads: () =>
        searchPage([
          null,
          {},
          {
            number: 218,
            reviewThreads: {
              pageInfo: { hasNextPage: false },
              // Junk thread entries ride along; only a real isResolved
              // false counts as unresolved.
              nodes: [{ isResolved: false }, null, "junk"],
            },
          },
          { number: 219, reviewThreads: { nodes: [{ isResolved: false }] } },
          { number: 222, reviewThreads: null },
          { number: 223, reviewThreads: { pageInfo: { hasNextPage: false }, nodes: "nope" } },
        ]),
    });
    const { facts } = await prFacts(deps);
    const byNumber = new Map(facts.map((f) => [f.number, f]));
    expect(byNumber.get(218)?.unresolvedThreads).toBe(1);
    // Shape unreadable — missing pageInfo, null threads, a non-list of
    // threads — is no count: each stays unknown, and the good row survives.
    expect(byNumber.get(219)?.unresolvedThreads).toBe("unknown");
    expect(byNumber.get(222)?.unresolvedThreads).toBe("unknown");
    expect(byNumber.get(223)?.unresolvedThreads).toBe("unknown");
  });

  test("no row carried a repo: the query cannot be built, it is not run, opens are unknown", async () => {
    const { deps, calls } = threadDeps({
      list: [
        { number: 218, state: "OPEN", headRefName: "feat/t1", headRefOid: "o" },
        { number: 220, state: "OPEN", headRefName: "feat/v3", headRefOid: "o", repo: null },
      ],
    });
    const { facts } = await prFacts(deps);
    expect(calls.some((args) => args[1] === "graphql")).toBe(false);
    expect(facts.map((f) => f.unresolvedThreads)).toEqual(["unknown", "unknown"]);
  });

  test("a row whose repo is a number is an unreadable row, counted and skipped", async () => {
    const corpus = await prFacts(
      fakeDeps({
        gh: async () =>
          JSON.stringify([
            { number: 218, state: "OPEN", headRefName: "feat/t1", headRefOid: "o", repo: 7 },
          ]),
      }),
    );
    expect(corpus).toEqual({ facts: [], skipped: 1 });
  });
});

describe("parsePrList", () => {
  test("a truncated last row is skipped and counted, and the rows before it are kept", () => {
    const rows = [
      JSON.stringify({ number: 1, state: "OPEN", headRefName: "feat/a", headRefOid: "oa" }),
      '{"number":2,"state":"OPEN"',
    ];
    expect(parsePrList(rows.join("\n"))).toEqual({
      entries: [{ number: 1, state: "OPEN", headRefName: "feat/a", headRefOid: "oa" }],
      skipped: 1,
    });
  });

  test("a truncated array is read as rows, not discarded whole", () => {
    const truncated = '[{"number":1,"state":"OPEN","headRefName":"feat/a","headRefOid":"oa"}';
    expect(parsePrList(truncated)).toEqual({ entries: [], skipped: 1 });
  });

  test("blank lines are not rows, and an empty output is an empty corpus with no gap", () => {
    const row = JSON.stringify({ number: 1, state: "OPEN", headRefName: "feat/a", headRefOid: "oa" });
    expect(parsePrList(`\n${row}\n\n`)).toEqual({
      entries: [{ number: 1, state: "OPEN", headRefName: "feat/a", headRefOid: "oa" }],
      skipped: 0,
    });
    expect(parsePrList("")).toEqual({ entries: [], skipped: 0 });
  });

  test("a JSON array keeps the elements that read and counts the ones that do not", () => {
    const parsed = parsePrList(
      JSON.stringify([
        { number: 1, state: "OPEN", headRefName: "feat/a", headRefOid: "oa" },
        { number: 2, state: "OPEN" },
      ]),
    );
    expect(parsed.skipped).toBe(1);
    expect(parsed.entries.map((entry) => entry.number)).toEqual([1]);
  });
});

describe("joinPrForLane", () => {
  function fact(
    number: number,
    branchTail: string,
    state: "open" | "merged" | "closed" = "merged",
    checks: "none" | "pending" | "pass" | "fail" = "none",
  ): PrFact {
    return { number, state, checks, branchTail };
  }

  const facts = [
    fact(273, "l3b-layer-props"),
    fact(265, "l2a-layer-list"),
    fact(221, "main"),
  ];

  test("the event's own pr number wins over any branch match", () => {
    const withExact = [...facts, fact(999, "l3b-layer-props", "open", "pending")];
    expect(joinPrForLane("L3b-layer-props", 273, withExact)).toEqual({
      number: 273,
      state: "merged",
      checks: "none",
    });
  });

  test("an event pr gh does not know falls back to the branch", () => {
    expect(joinPrForLane("L3b-layer-props", 111111, facts)).toEqual({
      number: 273,
      state: "merged",
      checks: "none",
    });
  });

  test("the branch fallback is case- and prefix-insensitive", () => {
    expect(joinPrForLane("L3b-layer-props", undefined, facts)?.number).toBe(273);
    expect(joinPrForLane("h2-hit-testing", undefined, [fact(285, "h2-hit-testing")])?.number).toBe(285);
  });

  test("an exact tail beats a descendant even with an older number", () => {
    const candidates = [
      fact(300, "l5-template-editor-2"),
      fact(278, "l5-template-editor"),
    ];
    expect(joinPrForLane("L5-template-editor", undefined, candidates)?.number).toBe(278);
  });

  test("among descendants the newest PR wins, and an older one keeps the seat", () => {
    expect(
      joinPrForLane("l5", undefined, [fact(300, "l5-editor"), fact(290, "l5-editor-2")])?.number,
    ).toBe(300);
    expect(
      joinPrForLane("l5", undefined, [fact(290, "l5-editor-2"), fact(300, "l5-editor")])?.number,
    ).toBe(300);
  });

  test("a lane never joins a sibling that merely shares a prefix", () => {
    expect(joinPrForLane("w1", undefined, [fact(282, "w1a-status-cli"), fact(221, "main")])).toBeUndefined();
  });
});

describe("collect — the PR-to-lane join", () => {
  const joinTree = (files: Record<string, string>, ghList: unknown): FakeTree => ({
    dirs: {
      [ROOT]: ["waveJ"],
      [`${ROOT}/waveJ`]: [...Object.keys(files).map((p) => p.slice(`${ROOT}/waveJ/`.length))],
    },
    files,
    gh: async (args) =>
      ((args[0] === "api" && args[1].includes("pulls")) || args[0] === "pr"
        ? JSON.stringify(ghList)
        : "not json"),
  });

  test("a lane whose event carries pr shows that PR when no branch could have found it", async () => {
    const status = await collect(
      fakeDeps(
        joinTree(
          {
            [`${ROOT}/waveJ/L2a-compositor-layer-list.log`]: "done\n",
            [`${ROOT}/waveJ/events.jsonl`]:
              '{"ts":"2026-09-08T22:07:15Z","wave":"J","lane":"L2a-compositor-layer-list","stage":"implement","event":"settled","pr":265}\n',
          },
          [{ number: 265, state: "MERGED", headRefName: "feat/l2a-layer-list", headRefOid: "o" }],
        ),
      ),
      ROOT,
      "now",
    );
    const row = status.waves[0]?.lanes.find((lane) => lane.lane === "L2a-compositor-layer-list");
    expect(row?.derived.pr).toEqual({ number: 265, state: "merged", checks: "unknown" });
  });

  test("a lane whose event carries no pr joins by the normalised branch tail", async () => {
    const status = await collect(
      fakeDeps(
        joinTree(
          {
            [`${ROOT}/waveJ/H1a-tokens-selector.log`]: "done\n",
            [`${ROOT}/waveJ/events.jsonl`]:
              '{"ts":"2026-09-08T22:07:15Z","wave":"J","lane":"H1a-tokens-selector","stage":"implement","event":"settled"}\n',
          },
          [{ number: 280, state: "MERGED", headRefName: "fix/h1a-tokens-selector", headRefOid: "o" }],
        ),
      ),
      ROOT,
      "now",
    );
    expect(status.waves[0]?.lanes[0]?.derived.pr).toEqual({
      number: 280,
      state: "merged",
      checks: "unknown",
    });
  });

  test("the event pr wins when it disagrees with the branch match", async () => {
    const status = await collect(
      fakeDeps(
        joinTree(
          {
            [`${ROOT}/waveJ/L3b-layer-props.log`]: "done\n",
            [`${ROOT}/waveJ/events.jsonl`]:
              '{"ts":"2026-09-08T22:07:15Z","wave":"J","lane":"L3b-layer-props","stage":"implement","event":"settled","pr":273}\n',
          },
          [
            { number: 273, state: "MERGED", headRefName: "feat/l3b-layer-props", headRefOid: "o" },
            { number: 999, state: "OPEN", headRefName: "feat/l3b-layer-props-suffix", headRefOid: "o" },
          ],
        ),
      ),
      ROOT,
      "now",
    );
    expect(status.waves[0]?.lanes[0]?.derived.pr?.number).toBe(273);
  });

  test("a later event without pr does not unjoin the earlier one that carried it", async () => {
    const status = await collect(
      fakeDeps(
        joinTree(
          {
            [`${ROOT}/waveJ/L3b-layer-props.log`]: "done\n",
            [`${ROOT}/waveJ/events.jsonl`]:
              '{"ts":"2026-09-08T22:07:15Z","wave":"J","lane":"L3b-layer-props","stage":"implement","event":"settled","pr":273}\n' +
              '{"ts":"2026-09-08T22:08:15Z","wave":"J","lane":"L3b-layer-props","stage":"merge","event":"started"}\n',
          },
          [{ number: 273, state: "MERGED", headRefName: "feat/l3b-layer-props", headRefOid: "o" }],
        ),
      ),
      ROOT,
      "now",
    );
    expect(status.waves[0]?.lanes[0]?.reported?.stage).toBe("merge");
    expect(status.waves[0]?.lanes[0]?.derived.pr?.number).toBe(273);
  });

  test("events from another wave's directory cannot leak a pr into this one", async () => {
    const status = await collect(
      fakeDeps({
        dirs: {
          [ROOT]: ["waveJ", "waveK"],
          [`${ROOT}/waveJ`]: ["L3b.log", "events.jsonl"],
          [`${ROOT}/waveK`]: ["events.jsonl"],
        },
        files: {
          [`${ROOT}/waveJ/L3b.log`]: "done\n",
          [`${ROOT}/waveJ/events.jsonl`]:
            '{"ts":"2026-09-08T22:07:15Z","wave":"J","lane":"L3b","stage":"implement","event":"settled"}\n',
          [`${ROOT}/waveK/events.jsonl`]:
            '{"ts":"2026-09-08T22:07:15Z","wave":"K","lane":"L3b","stage":"implement","event":"settled","pr":273}\n',
        },
        gh: async () =>
          JSON.stringify([
            { number: 273, state: "MERGED", headRefName: "feat/other-lane", headRefOid: "o" },
          ]),
      }),
      ROOT,
      "now",
    );
    const row = status.waves.find((wave) => wave.id === "J")?.lanes[0];
    expect(row?.derived.pr).toBeUndefined();
    // The other directory's claim belongs to its own lane, not this one's row.
    expect(
      status.waves.find((wave) => wave.id === "K")?.lanes[0]?.derived.pr?.number,
    ).toBe(273);
  });
});

describe("collect — event-only lanes", () => {
  test("a lane with events and no log shows its PR and its liveness", async () => {
    // The shape lanes are dispatched in today: `events.jsonl` and no lane log.
    // The row used to exist only in the merge's event feed — `{ alive: false }`
    // with no probe behind it and no PR behind that — so the page answered
    // neither "what is running" nor "what landed" for it.
    const seen: string[] = [];
    const status = await collect(
      fakeDeps({
        dirs: { [ROOT]: ["wave-E"], [`${ROOT}/wave-E`]: ["events.jsonl"] },
        files: {
          [`${ROOT}/wave-E/events.jsonl`]:
            '{"ts":"2026-09-12T10:00:00Z","wave":"E","lane":"e1","stage":"implement","event":"settled","pr":350}\n',
        },
        pgrep: async (pattern) => {
          seen.push(pattern);
          return pattern === "cf-e1(/|$| )" ? 1 : 0;
        },
        gh: async (args) => {
          if (args[0] === "api" && args[1].includes("pulls")) {
            return JSON.stringify([
              { number: 350, state: "OPEN", headRefName: "feat/renamed-props", headRefOid: "oidE" },
            ]);
          }
          if (args[0] === "api" && args[1].includes("check-runs")) {
            return JSON.stringify({
              check_runs: [{ name: "Build", status: "completed", conclusion: "success" }],
            });
          }
          throw new Error(`unexpected gh call: ${args.join(" ")}`);
        },
      }),
      ROOT,
      "now",
    );
    const lane = status.waves[0]?.lanes[0];
    expect(lane?.lane).toBe("e1");
    expect(lane?.reported).toMatchObject({ stage: "implement", event: "settled", pr: 350 });
    // Liveness is a probe result, not a default: the pattern was run.
    expect(seen).toEqual(["cf-e1(/|$| )"]);
    expect(lane?.derived.alive).toBe(true);
    expect(lane?.derived.log).toBeUndefined();
    // The event's own pr is the join, and the head it names is claimed for
    // checks — the branch tail matches nothing here. No row carried a repo,
    // so threads could not be asked; that is a value, not a silence.
    expect(lane?.derived.pr).toEqual({
      number: 350,
      state: "open",
      checks: "pass",
      unresolvedThreads: "unknown",
    });
  });

  test("an event-only lane gets a row; a lane with a log keeps its one row and one probe", async () => {
    const seen: string[] = [];
    const status = await collect(
      fakeDeps({
        dirs: { [ROOT]: ["wave-F"], [`${ROOT}/wave-F`]: ["f1.log", "events.jsonl"] },
        files: {
          [`${ROOT}/wave-F/f1.log`]: "building\n",
          [`${ROOT}/wave-F/events.jsonl`]:
            '{"ts":"2026-09-12T10:00:00Z","wave":"F","lane":"f1","stage":"implement","event":"started"}\n' +
            '{"ts":"2026-09-12T10:01:00Z","wave":"F","lane":"f2","stage":"gate","event":"started"}\n',
        },
        pgrep: async (pattern) => {
          seen.push(pattern);
          return 0;
        },
      }),
      ROOT,
      "now",
    );
    const lanes = status.waves[0]?.lanes ?? [];
    expect(lanes.map((lane) => lane.lane)).toEqual(["f1", "f2"]);
    expect(seen).toEqual(["cf-f1(/|$| )", "cf-f2(/|$| )"]);
    // The log lane is unchanged by the second source: same row, log intact.
    expect(lanes[0]?.derived.log?.tail).toBe("building\n");
    expect(lanes[1]?.derived.log).toBeUndefined();
  });

  test("a failed probe on an event-only lane still lists the lane, alive:false, and the hang surfaces", async () => {
    // A probe that cannot run shrinks the observation to `alive: false` — the
    // same shrink the log loop accepts — but never removes the row: a lane
    // that reported `started` and cannot be confirmed alive is exactly what
    // the operator needs to see.
    const status = await collect(
      fakeDeps({
        dirs: { [ROOT]: ["wave-G"], [`${ROOT}/wave-G`]: ["events.jsonl"] },
        files: {
          [`${ROOT}/wave-G/events.jsonl`]:
            '{"ts":"2026-09-12T10:00:00Z","wave":"G","lane":"g1","stage":"implement","event":"started"}\n',
        },
        pgrep: async () => {
          throw new Error("pgrep exploded");
        },
      }),
      ROOT,
      "now",
    );
    const lane = status.waves[0]?.lanes[0];
    expect(lane?.lane).toBe("g1");
    expect(lane?.derived.alive).toBe(false);
    expect(lane?.disagreements).toEqual([
      "lane says implement started; the process is not alive and the log has no EXIT marker",
    ]);
  });

  test("an event-only lane carries its gate log: the exit and the coverage beside the events", async () => {
    // The gate runs whether or not the lane wrote a log, and it writes
    // `gate-<lane>.log` into the same directory the events live in. A row
    // built from the event feed that skips the gate lookup renders the single
    // most important field — did the gate pass — as empty for exactly the
    // lanes S2 exists to surface.
    const status = await collect(
      fakeDeps({
        dirs: {
          [ROOT]: ["wave-H"],
          [`${ROOT}/wave-H`]: ["events.jsonl", "gate-h1.log", "gate-h1-2.log"],
        },
        files: {
          [`${ROOT}/wave-H/events.jsonl`]:
            '{"ts":"2026-09-12T10:00:00Z","wave":"H","lane":"h1","stage":"gate","event":"settled"}\n',
          [`${ROOT}/wave-H/gate-h1.log`]: "GATE EXIT 1\n",
          [`${ROOT}/wave-H/gate-h1-2.log`]:
            "Statements   : 100% ( 100/100 )\nBranches     : 100% ( 578/578 )\nFunctions    : 100% ( 20/20 )\nLines        : 100% ( 100/100 )\nGATE EXIT 0\n",
        },
      }),
      ROOT,
      "now",
    );
    const lane = status.waves[0]?.lanes[0];
    expect(lane?.lane).toBe("h1");
    expect(lane?.derived.log).toBeUndefined();
    expect(lane?.derived.gate).toEqual({
      exit: 0,
      coverage: { statements: 100, branches: 100, functions: 100, lines: 100 },
    });
  });
});

describe("parseChecks", () => {
  test("an unfinished or conclusion-less Build run is pending", () => {
    expect(
      parseChecks(
        JSON.stringify({
          check_runs: [
            { name: "Build", status: "completed", conclusion: null },
            { name: "Lint", status: "completed", conclusion: "success" },
          ],
        }),
      ),
    ).toBe("pending");
    expect(
      parseChecks(
        JSON.stringify({ check_runs: [{ name: "Build", status: "queued", conclusion: null }] }),
      ),
    ).toBe("pending");
  });

  test("a failed Build run is fail", () => {
    expect(
      parseChecks(
        JSON.stringify({ check_runs: [{ name: "Build", status: "completed", conclusion: "failure" }] }),
      ),
    ).toBe("fail");
  });

  test("a completed successful Build run is pass", () => {
    expect(
      parseChecks(
        JSON.stringify({ check_runs: [{ name: "Build", status: "completed", conclusion: "success" }] }),
      ),
    ).toBe("pass");
  });

  test("runs not named Build are ignored; no Build runs is none", () => {
    expect(
      parseChecks(
        JSON.stringify({ check_runs: [{ name: "Lint", status: "completed", conclusion: "failure" }] }),
      ),
    ).toBe("none");
    expect(parseChecks(JSON.stringify({ total_count: 0, check_runs: [] }))).toBe("none");
  });

  test("a payload without a readable check_runs list is unknown, never a silent none", () => {
    // The read came back but says nothing we can stand on — a different fact
    // from "the list is empty", which is none. H2: none must mean exactly one
    // thing: we asked, and no Build check has run.
    expect(parseChecks(JSON.stringify({}))).toBe("unknown");
    expect(parseChecks("[]")).toBe("unknown");
    expect(parseChecks("1")).toBe("unknown");
    expect(parseChecks("null")).toBe("unknown");
    expect(parseChecks('{"check_runs": "not a list"}')).toBe("unknown");
  });

  test("a run without a name is ignored", () => {
    expect(
      parseChecks(
        JSON.stringify({ check_runs: [{ status: "completed", conclusion: "success" }] }),
      ),
    ).toBe("none");
    // Junk run entries ride along; a named Build still reads.
    expect(
      parseChecks(
        JSON.stringify({
          check_runs: [null, "junk", { name: "Build", status: "queued", conclusion: null }],
        }),
      ),
    ).toBe("pending");
  });

  test("bad JSON is unknown, never a throw and never a silent none", () => {
    expect(parseChecks("<<<")).toBe("unknown");
  });
});

describe("waveIdFromDirName", () => {
  test("strips the leading wave and optional separator while preserving identifier hyphens", () => {
    expect(waveIdFromDirName("waveT")).toBe("T");
    expect(waveIdFromDirName("wave-2")).toBe("2");
    expect(waveIdFromDirName("waves")).toBe("s");
    expect(waveIdFromDirName("wave-creative-templates-w03")).toBe("creative-templates-w03");
  });
});

describe("realDeps — the process-level wiring", () => {
  function stubExec(behavior: (file: string, args: readonly string[]) => [ExecError | null, string]): void {
    execFileMock.mockImplementation(
      (
        file: string,
        args: readonly string[],
        optionsOrCallback: ExecCallback | Record<string, unknown>,
        maybeCallback?: ExecCallback,
      ) => {
        const callback = (
          typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback
        ) as ExecCallback;
        const [error, stdout] = behavior(file, args);
        queueMicrotask(() => callback(error, stdout));
        return undefined;
      },
    );
  }

  test("readdir, readFile and open read the real filesystem", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wave-status-deps-"));
    const file = join(dir, "t1.log");
    await writeFile(file, "hello\n");
    expect(await realDeps.readdir(dir)).toContain("t1.log");
    expect(await realDeps.readFile(file)).toBe("hello\n");
    const fh = await realDeps.open(file);
    try {
      expect(await fh.stat()).toMatchObject({ size: 6 });
      const buf = Buffer.alloc(5);
      const { bytesRead } = await fh.read(buf, 0, 5, 1);
      expect(bytesRead).toBe(5);
      expect(buf.toString("utf8")).toBe("ello\n");
    } finally {
      await fh.close();
    }
  });

  test("pgrep counts pids; 'no match' (exit 1) is a count of zero", async () => {
    stubExec(() => [null, "101\n102\n\n"]);
    await expect(realDeps.pgrep("wt-t1")).resolves.toBe(2);
    stubExec(() => [execExit(1), ""]);
    await expect(realDeps.pgrep("wt-nomatch")).resolves.toBe(0);
  });

  test("pgrep rejects on a real pgrep failure (exit other than 0/1)", async () => {
    stubExec(() => [execExit(2), ""]);
    await expect(realDeps.pgrep("[")).rejects.toMatchObject({ code: 2 });
  });

  test("gh resolves stdout; a gh failure rejects (collect turns that into no PRs)", async () => {
    stubExec(() => [null, "[]"]);
    await expect(realDeps.gh(["pr", "list"])).resolves.toBe("[]");
    stubExec(() => [new Error("gh: not found"), ""]);
    await expect(realDeps.gh(["pr", "list"])).rejects.toThrow("gh: not found");
  });

  test("git resolves stdout; a git failure rejects (collect turns that into no worktrees)", async () => {
    stubExec(() => [null, "worktree /path\n"]);
    await expect(realDeps.git?.(["worktree", "list"])).resolves.toBe("worktree /path\n");
    stubExec(() => [new Error("git: not found"), ""]);
    await expect(realDeps.git?.(["worktree", "list"])).rejects.toThrow("git: not found");
  });

  test("worktreeFacts handles undefined git, errors, and empty responses", async () => {
    expect(await worktreeFacts({} as CollectDeps)).toEqual([]);
    expect(
      await worktreeFacts({
        git: async () => {
          throw new Error("git error");
        },
      } as unknown as CollectDeps),
    ).toEqual([]);
    expect(
      await worktreeFacts({
        git: async () => "worktree /path/one\nbranch refs/heads/main\n\nworktree /path/two\n",
      } as unknown as CollectDeps),
    ).toEqual(["/path/one", "/path/two"]);
  });

  test("derivePrefix handles worktree paths and returns undefined when no pattern matches", () => {
    expect(derivePrefix(["/path/cf-c5", "/path/cf-t4"])).toBe("cf-");
    expect(derivePrefix(["/path/wt-t1"])).toBe("wt-");
    expect(derivePrefix(["/path/nomatch"])).toBeUndefined();
    expect(derivePrefix([])).toBeUndefined();
  });

  test("pgrepPattern handles base === lane and unmatched worktrees fallback", () => {
    expect(pgrepPattern("c5", ["/path/c5"])).toBe("c5(/|$| )");
    expect(pgrepPattern("c5", ["/path/nomatch"])).toBe("cf-c5(/|$| )");
  });

  test("the default backlog path is derived from the selected root rather than module-load env", async () => {
    const readPaths: string[] = [];
    const root = "/custom/workspace/waves";
    const artifactPath = join(root, "plan-verify.json");
    const deps: CollectDeps = {
      readdir: async () => [],
      readFile: async (p) => {
        readPaths.push(p);
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      open: async () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      pgrep: async () => 0,
      gh: async () => "[]",
    };
    await collect(deps, root, "2026-09-13T12:00:00.000Z");
    expect(readPaths).toContain(artifactPath);
  });

  test("PLAN_VERIFY_ARTIFACT still overrides the root-derived default artifact path", async () => {
    const readPaths: string[] = [];
    const root = "/custom/workspace/waves";
    const overridePath = "/override/custom-verify.json";
    const oldEnv = process.env.PLAN_VERIFY_ARTIFACT;
    process.env.PLAN_VERIFY_ARTIFACT = overridePath;
    try {
      const deps: CollectDeps = {
        readdir: async () => [],
        readFile: async (p) => {
          readPaths.push(p);
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        },
        open: async () => {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        },
        pgrep: async () => 0,
        gh: async () => "[]",
      };
      await collect(deps, root, "2026-09-13T12:00:00.000Z");
      expect(readPaths).toContain(overridePath);
    } finally {
      if (oldEnv === undefined) delete process.env.PLAN_VERIFY_ARTIFACT;
      else process.env.PLAN_VERIFY_ARTIFACT = oldEnv;
    }
  });

  test("realDeps does not fix planVerifyArtifactPath at module load", () => {
    expect(realDeps.planVerifyArtifactPath).toBeUndefined();
  });
});
