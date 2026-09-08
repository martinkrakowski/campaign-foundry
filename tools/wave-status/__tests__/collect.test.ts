import { describe, test, expect, vi, type Mock } from "vitest";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

import { execFile } from "node:child_process";
import { collect, parseChecks, realDeps, waveIdFromDirName } from "../lib/collect.js";
import type { CollectDeps } from "../lib/collect.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileMock = execFile as unknown as Mock;
type ExecError = Error & { code?: number };
type ExecCallback = (error: ExecError | null, stdout: string) => void;

const execExit = (code: number): ExecError => Object.assign(new Error(`exit ${code}`), { code });

interface FakeTree {
  readonly dirs?: Record<string, readonly string[]>;
  readonly files?: Record<string, string>;
  readonly pgrep?: (pattern: string) => Promise<number>;
  readonly gh?: (args: readonly string[]) => Promise<string>;
}

function fakeDeps({ dirs = {}, files = {}, pgrep = async () => 0, gh = async () => "[]" }: FakeTree): CollectDeps {
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
    stat: async (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT: stat ${path}`);
      return { size: text.length, mtimeMs: 1_000 };
    },
    pgrep,
    gh,
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
    if (pattern === "wt-t1") return 0;
    if (pattern === "wt-u2") return 2;
    if (pattern === "wt-v3") throw new Error("pgrep exploded");
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
    // gate-<lane>*.log: both gate-u2.log and gate-u2-2.log match, and the
    // lexicographically last wins ("-" sorts before "."), so gate-u2.log.
    expect(u2?.derived.gate).toEqual({ exit: 1 });
    expect(u2?.derived.pr).toBeUndefined();

    const v3 = status.waves[2]?.lanes[0];
    expect(v3?.lane).toBe("v3");
    expect(v3?.derived.alive).toBe(false);
    expect(v3?.derived.gate).toBeUndefined();
    expect(v3?.derived.pr).toBeUndefined();
    expect(v3?.reported).toBeUndefined();
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

  test("readdir, readFile and stat read the real filesystem", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wave-status-deps-"));
    const file = join(dir, "t1.log");
    await writeFile(file, "hello\n");
    expect(await realDeps.readdir(dir)).toContain("t1.log");
    expect(await realDeps.readFile(file)).toBe("hello\n");
    expect(await realDeps.stat(file)).toMatchObject({ size: 6 });
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
});
