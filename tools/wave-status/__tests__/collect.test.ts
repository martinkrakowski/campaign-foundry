import { describe, test, expect, vi, type Mock } from "vitest";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

import { execFile } from "node:child_process";
import {
  collect,
  derivePrefix,
  LOG_TAIL_BYTES,
  parseChecks,
  pgrepPattern,
  realDeps,
  waveIdFromDirName,
  worktreeFacts,
} from "../lib/collect.js";
import type { CollectDeps, TailHandle } from "../lib/collect.js";
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
}

function fakeDeps({
  dirs = {},
  files = {},
  pgrep = async () => 0,
  gh = async () => "[]",
  git,
}: FakeTree): CollectDeps {
  return {
    readdir: async (dir) => {
      const names = dirs[dir];
      if (names === undefined) throw new Error(`ENOENT: readdir ${dir}`);
      return names;
    },
    readFile: async (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT: readFile ${path}`);
      return text;
    },
    open: async (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT: open ${path}`);
      const data = Buffer.from(text, "utf8");
      return memoryHandle(data);
    },
    pgrep,
    gh,
    ...(git ? { git } : {}),
  };
}

function memoryHandle(data: Buffer): TailHandle {
  return {
    async stat() {
      return { size: data.length, mtimeMs: 1_000 };
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
    [`${ROOT}/waveU`]: ["u2.log", "gate-u2.log", "gate-u2-2.log"],
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
    [`${ROOT}/waveU/u2.log`]: "working silently\n",
    [`${ROOT}/waveU/gate-u2.log`]: "GATE EXIT 1\n",
    [`${ROOT}/waveU/gate-u2-2.log`]: "GATE EXIT 0\n",
    [`${ROOT}/waveV/v3.log`]: "running\n",
    // gate-v3.log is listed but unreadable; waveV/events.jsonl likewise.
  },
  pgrep: async (pattern) => {
    if (pattern === "cf-t1(/|$| )") return 0;
    if (pattern === "cf-u2(/|$| )") return 2;
    if (pattern === "cf-v3(/|$| )") throw new Error("pgrep exploded");
    return 0;
  },
  gh: async (args) => {
    if (args[0] === "pr") {
      return JSON.stringify([
        { number: 218, state: "OPEN", headRefName: "feat/t1", headRefOid: "oid1" },
        { number: 220, state: "OPEN", headRefName: "feat/v3", headRefOid: "oid3" },
        { number: 221, state: "OPEN", headRefName: "main", headRefOid: "oidX" },
        { number: 222, state: "DRAFTED", headRefName: "feat/t9", headRefOid: "oidY" },
        { number: 223, state: "MERGED", headRefName: "feat/w9", headRefOid: "oid9" },
        { number: 224, state: "CLOSED", headRefName: "feat/w8", headRefOid: "oid8" },
      ]);
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
    expect(status.waves.map((wave) => wave.id)).toEqual(["T", "U", "V"]);

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
    expect(t1?.derived.pr).toEqual({ number: 218, state: "open", checks: "pending" });

    const u2 = status.waves[1]?.lanes[0];
    expect(u2?.lane).toBe("u2");
    expect(u2?.reported).toBeUndefined();
    expect(u2?.derived.alive).toBe(true);
    // Round 2 (gate-u2-2.log, EXIT 0) beats round 0 (gate-u2.log, EXIT 1).
    expect(u2?.derived.gate).toEqual({ exit: 0 });
    expect(u2?.derived.pr).toBeUndefined();

    const v3 = status.waves[2]?.lanes[0];
    expect(v3?.lane).toBe("v3");
    expect(v3?.derived.alive).toBe(false);
    expect(v3?.derived.gate).toBeUndefined();
    // check-runs failed for oid3; the PR is still listed with checks none.
    expect(v3?.derived.pr).toEqual({ number: 220, state: "open", checks: "none" });
    expect(v3?.reported).toBeUndefined();
  });

  test("three gate rounds pick the highest n, not the lexicographic last", async () => {
    const status = await collect(
      fakeDeps({
        dirs: {
          [ROOT]: ["waveR"],
          // Highest round listed first so a lexicographic pick still prefers
          // gate-r1.log (because "-" < ".") and the assertion cannot pass by luck.
          [`${ROOT}/waveR`]: ["r1.log", "gate-r1-3.log", "gate-r1-2.log", "gate-r1.log"],
        },
        files: {
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
          [`${ROOT}/waveS`]: ["s2.log", "s2i.log", "gate-s2.log", "gate-s2i.log"],
        },
        files: {
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
        dirs: { [ROOT]: ["waveS"], [`${ROOT}/waveS`]: ["s2.log"] },
        files: { [`${ROOT}/waveS/s2.log`]: "x\n" },
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
      t1: { number: 7, state: "open", checks: "pass" },
    });
    expect(gh).not.toHaveBeenCalled();
    expect(status.waves[0]?.lanes[0]?.derived.pr).toEqual({ number: 7, state: "open", checks: "pass" });
    expect(status.waves[1]?.lanes[0]?.derived.pr).toBeUndefined();
  });

  test("a failing gh yields the same rows with pr absent, never a throw", async () => {
    const status = await collect(
      fakeDeps({ ...TREE, gh: async () => { throw new Error("gh: no auth"); } }),
      ROOT,
      "now",
    );
    const t1 = status.waves[0]?.lanes[0];
    expect(t1?.reported).toMatchObject({ stage: "implement" });
    expect(t1?.derived.pr).toBeUndefined();
    expect(status.waves.map((wave) => wave.id)).toEqual(["T", "U", "V"]);
  });

  test("malformed gh output is no PRs, not a crash", async () => {
    const status = await collect(
      fakeDeps({ ...TREE, gh: async () => "not json" }),
      ROOT,
      "now",
    );
    expect(status.waves[0]?.lanes[0]?.derived.pr).toBeUndefined();
  });

  test("wrong-shape gh JSON is no PRs on every row, never a throw", async () => {
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
      JSON.stringify([
        { number: 218, state: "OPEN", headRefName: "feat/t1", headRefOid: "oid1" },
        { number: 219 },
      ]),
    ];
    for (const body of bodies) {
      const status = await collect(fakeDeps({ ...TREE, gh: async () => body }), ROOT, "now");
      for (const wave of status.waves) {
        for (const lane of wave.lanes) {
          expect({ body, pr: lane.derived.pr }).toEqual({ body, pr: undefined });
        }
      }
    }
  });

  test("a log larger than the tail is read from the end, not whole", async () => {
    const big = `${"x".repeat(2 * 1024 * 1024)}EXIT 0\n`;
    const logPath = `${ROOT}/waveB/b1.log`;
    const inner = fakeDeps({
      dirs: { [ROOT]: ["waveB"], [`${ROOT}/waveB`]: ["b1.log"] },
      files: { [logPath]: big },
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
    expect(status).toEqual({ generatedAt: "now", waves: [] });
  });

  test("a lane log that vanishes between listing and reading drops the log, keeps the row", async () => {
    const status = await collect(
      fakeDeps({
        dirs: { [ROOT]: ["waveX"], [`${ROOT}/waveX`]: ["x1.log"] },
        files: {},
      }),
      ROOT,
      "now",
    );
    const x1 = status.waves[0]?.lanes[0];
    expect(x1?.lane).toBe("x1");
    expect(x1?.derived.log).toBeUndefined();
    expect(x1?.derived.alive).toBe(false);
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

  test("a payload without check_runs is none", () => {
    expect(parseChecks(JSON.stringify({}))).toBe("none");
  });

  test("a run without a name is ignored", () => {
    expect(
      parseChecks(
        JSON.stringify({ check_runs: [{ status: "completed", conclusion: "success" }] }),
      ),
    ).toBe("none");
  });

  test("bad JSON is none, never a throw", () => {
    expect(parseChecks("<<<")).toBe("none");
  });
});

describe("waveIdFromDirName", () => {
  test("strips the leading wave and any dashes", () => {
    expect(waveIdFromDirName("waveT")).toBe("T");
    expect(waveIdFromDirName("wave-2")).toBe("2");
    expect(waveIdFromDirName("waves")).toBe("s");
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
});
