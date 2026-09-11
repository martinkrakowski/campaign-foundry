import { execFile } from "node:child_process";
import { open as fsOpen, readdir as fsReaddir, readFile as fsReadFile } from "node:fs/promises";
import { join } from "node:path";
import { readEvents } from "./events.js";
import { mergeStatus } from "./merge.js";
import type { LaneObservation, WaveEvent, WaveStatus } from "./types.js";

/**
 * A readable file opened for a ranged tail. `FileHandle` satisfies this;
 * tests inject a counter so a whole-file read cannot hide.
 */
export interface TailHandle {
  stat(): Promise<{ readonly size: number; readonly mtimeMs: number }>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

/**
 * The process-facing side of collection. Everything impure is behind this
 * interface — `collect` itself only orchestrates, so tests drive it through
 * stubs and never touch the filesystem or the network.
 */
export interface CollectDeps {
  readonly readdir: (dir: string) => Promise<readonly string[]>;
  readonly readFile: (path: string) => Promise<string>;
  readonly open: (path: string) => Promise<TailHandle>;
  readonly pgrep: (pattern: string) => Promise<number>;
  readonly gh: (args: readonly string[]) => Promise<string>;
  readonly git?: (args: readonly string[]) => Promise<string>;
}

/** Wave log directories live directly under here: `/tmp/wave*`. */
export const WAVE_LOG_ROOT = "/tmp";

/** How much of a lane log travels with the observation (the EXIT marker lives at the end). */
export const LOG_TAIL_BYTES = 16 * 1024;

/** Public `?tail=` is in KB; anything above this is 400, not an unbounded read. */
export const MAX_TAIL_KB = 1024;

/** Prefixed families are pipeline artefacts, not lane logs. */
const LANE_LOG_EXCLUDED = /^(install|gate|review|fix)-/;

const PR_BRANCH_PREFIX = "feat/";

interface GhPrListEntry {
  readonly number: number;
  readonly state: string;
  readonly headRefName: string;
  readonly headRefOid: string;
}

export function waveIdFromDirName(name: string): string {
  return name.replace(/^wave/, "").replace(/-/g, "");
}

/**
 * Walk the wave log tree and build the one `WaveStatus` the server renders.
 * Every external result is data: a failing read or CLI call shrinks the
 * observation (no log, no gate, no PR) — it never throws (D103, D106).
 *
 * `cachedPrByLane`, when provided, is reused as-is: a watcher-triggered
 * refresh re-reads local state without waiting on `gh`. Omit it (or pass
 * nothing) to fetch PR facts now — startup, the slow poll, on-demand.
 */
export async function collect(
  deps: CollectDeps,
  root: string,
  now: string,
  cachedPrByLane?: Readonly<Record<string, LaneObservation["pr"]>>,
): Promise<WaveStatus> {
  const events: WaveEvent[] = [];
  const observed: Record<string, LaneObservation> = {};

  const prByLane = cachedPrByLane ?? (await prFacts(deps));
  const worktrees = await worktreeFacts(deps);

  let dirNames: readonly string[];
  try {
    dirNames = await deps.readdir(root);
  } catch {
    return mergeStatus(events, observed, now);
  }

  const waveDirs = dirNames.filter((name) => name.startsWith("wave")).sort();
  for (const name of waveDirs) {
    const dir = join(root, name);
    const wave = waveIdFromDirName(name);
    let entries: readonly string[];
    try {
      entries = await deps.readdir(dir);
    } catch {
      continue;
    }

    const laneLogs = entries
      .filter((entry) => entry.endsWith(".log") && !LANE_LOG_EXCLUDED.test(entry))
      .sort();
    for (const fileName of laneLogs) {
      const lane = fileName.slice(0, -".log".length);
      const logPath = join(dir, fileName);

      let log: LaneObservation["log"];
      try {
        const part = await readTail(deps.open, logPath, LOG_TAIL_BYTES);
        log = { bytes: part.size, mtimeMs: part.mtimeMs, tail: part.tail.toString("utf8") };
      } catch {
        log = undefined;
      }

      let alive = false;
      try {
        alive = (await deps.pgrep(pgrepPattern(lane, worktrees))) > 0;
      } catch {
        alive = false;
      }

      const gateName = newestGateLog(entries, lane);
      let gateLog: string | undefined;
      if (gateName !== undefined) {
        try {
          gateLog = await deps.readFile(join(dir, gateName));
        } catch {
          gateLog = undefined;
        }
      }

      observed[`${wave}/${lane}`] = {
        ...(log !== undefined ? { log } : {}),
        ...(gateLog !== undefined ? { gateLog } : {}),
        alive,
        ...(prByLane[lane] !== undefined ? { pr: prByLane[lane] } : {}),
      };
    }

    if (entries.includes("events.jsonl")) {
      try {
        const text = await deps.readFile(join(dir, "events.jsonl"));
        events.push(...readEvents(text).events);
      } catch {
        // W3 writes events.jsonl; absent or unreadable is "nobody reported", not an error.
      }
    }
  }

  return mergeStatus(events, observed, now);
}

/**
 * Last `maxBytes` of `path`, via `open` + `read` at `max(0, size − N)`.
 * Never reads the bytes before that window. The caller must not have the
 * file open already — this opens, reads, and closes.
 */
export async function readTail(
  open: (path: string) => Promise<TailHandle>,
  path: string,
  maxBytes: number,
): Promise<{ readonly size: number; readonly mtimeMs: number; readonly tail: Buffer }> {
  const handle = await open(path);
  try {
    const st = await handle.stat();
    const length = Math.min(Math.max(0, maxBytes), st.size);
    const position = Math.max(0, st.size - length);
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, position);
    return { size: st.size, mtimeMs: st.mtimeMs, tail: buf.subarray(0, bytesRead) };
  } finally {
    await handle.close();
  }
}

/**
 * One `gh pr list` plus check-runs for open heads, mapped to lanes by
 * branch name `feat/<lane>`. Any `gh` failure, or a well-formed body of the
 * wrong shape, yields no PRs — never a throw.
 */
export async function prFacts(deps: CollectDeps): Promise<Record<string, LaneObservation["pr"]>> {
  const byLane: Record<string, LaneObservation["pr"]> = {};

  let listed: readonly GhPrListEntry[] | undefined;
  try {
    listed = parsePrList(
      await deps.gh([
        "pr",
        "list",
        "--state",
        "all",
        "--json",
        "number,state,headRefName,headRefOid",
      ]),
    );
  } catch {
    return byLane;
  }
  if (listed === undefined) return byLane;

  for (const entry of listed) {
    if (!entry.headRefName.startsWith(PR_BRANCH_PREFIX)) continue;
    const lane = entry.headRefName.slice(PR_BRANCH_PREFIX.length);
    const state = entry.state.toLowerCase();
    if (state !== "open" && state !== "merged" && state !== "closed") continue;

    let checks: "none" | "pending" | "pass" | "fail" = "none";
    if (state === "open") {
      try {
        checks = parseChecks(
          await deps.gh(["api", `repos/:owner/:repo/commits/${entry.headRefOid}/check-runs`]),
        );
      } catch {
        // Transient check-runs failure: keep the PR, surface checks as none.
        checks = "none";
      }
    }

    byLane[lane] = { number: entry.number, state, checks };
  }

  return byLane;
}

/**
 * Check conclusions keyed on the runs this pipeline cares about — the ones
 * named `Build`. No Build runs → none; any unfinished → pending; any failed →
 * fail; otherwise pass. Bad JSON is "none", never a throw.
 */
export function parseChecks(json: string): "none" | "pending" | "pass" | "fail" {
  let builds: readonly { readonly name?: string; readonly status?: string; readonly conclusion?: string | null }[];
  try {
    const parsed = JSON.parse(json) as {
      readonly check_runs?: readonly {
        readonly name?: string;
        readonly status?: string;
        readonly conclusion?: string | null;
      }[];
    };
    builds = (parsed.check_runs ?? []).filter((run) => /^Build/.test(run.name ?? ""));
  } catch {
    return "none";
  }

  if (builds.length === 0) return "none";
  if (builds.some((run) => run.status !== "completed" || run.conclusion === null)) return "pending";
  if (builds.some((run) => run.conclusion !== "success")) return "fail";
  return "pass";
}

/**
 * `gh --json` is well-formed JSON of the wrong shape more often than it is
 * truncated: an object, a scalar, an array of partial rows. Anything other
 * than an array of `{number, state, headRefName, headRefOid}` is "no facts".
 */
function parsePrList(json: string): readonly GhPrListEntry[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  if (!parsed.every(isGhPrListEntry)) return undefined;
  return parsed;
}

function isGhPrListEntry(value: unknown): value is GhPrListEntry {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.number === "number" &&
    typeof rec.state === "string" &&
    typeof rec.headRefName === "string" &&
    typeof rec.headRefOid === "string"
  );
}

/** The deps the real server runs with: the actual filesystem, `pgrep` and `gh`. */
export const realDeps: CollectDeps = {
  readdir: (dir) => fsReaddir(dir),
  readFile: (path) => fsReadFile(path, "utf8"),
  open: async (path) => {
    const fh = await fsOpen(path, "r");
    return {
      stat: async () => {
        const st = await fh.stat();
        return { size: st.size, mtimeMs: st.mtimeMs };
      },
      read: (buffer, offset, length, position) => fh.read(buffer, offset, length, position),
      close: () => fh.close(),
    };
  },
  pgrep: (pattern) =>
    new Promise((resolve, reject) => {
      // pgrep exits 1 when nothing matched — that is a count of zero, not a failure.
      execFile("pgrep", ["-f", pattern], (error, stdout) => {
        if (error !== null && error.code !== 1) {
          reject(error);
        } else {
          resolve(countPids(stdout));
        }
      });
    }),
  gh: (args) =>
    new Promise((resolve, reject) => {
      execFile("gh", args, { timeout: 10_000 }, (error, stdout) => {
        if (error !== null) {
          reject(error);
        } else {
          resolve(stdout);
        }
      });
    }),
  git: (args) =>
    new Promise((resolve, reject) => {
      execFile("git", args, { timeout: 10_000 }, (error, stdout) => {
        if (error !== null) {
          reject(error);
        } else {
          resolve(stdout);
        }
      });
    }),
};

/**
 * Discover worktree paths from git (`git worktree list --porcelain`).
 * Any git failure yields an empty list — never a throw.
 */
export async function worktreeFacts(deps: CollectDeps): Promise<readonly string[]> {
  if (deps.git === undefined) return [];
  try {
    const stdout = await deps.git(["worktree", "list", "--porcelain"]);
    const paths: string[] = [];
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        paths.push(line.slice("worktree ".length).trim());
      }
    }
    return paths;
  } catch {
    return [];
  }
}

/**
 * Derive the naming prefix from existing worktrees (e.g. "cf-" from "cf-c5",
 * or "wt-" from "wt-t1").
 */
export function derivePrefix(worktrees: readonly string[]): string | undefined {
  const candidates = worktrees.length > 1 ? worktrees.slice(1) : worktrees;
  for (const wt of candidates) {
    const base = wt.split("/").pop() ?? "";
    const match = /^([A-Za-z0-9_]+-)[A-Za-z0-9_-]+$/.exec(base);
    if (match) return match[1];
  }
  return undefined;
}

function countPids(stdout: string): number {
  return stdout.split("\n").filter((line) => line.trim() !== "").length;
}

/** Escape a lane name for a JS / POSIX-ERE pattern. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `pgrep -f` is ERE against the full command line. Derive the pattern from
 * the worktree path the lane actually runs in (or the worktree naming convention
 * discovered from git), so the probe cannot silently drift from reality.
 * Fallback defaults to "cf-" (the current repository's convention).
 */
export function pgrepPattern(lane: string, worktrees?: readonly string[]): string {
  if (worktrees !== undefined && worktrees.length > 0) {
    for (const wt of worktrees) {
      const base = wt.split("/").pop() ?? "";
      if (base.endsWith(`-${lane}`) || base === lane) {
        return `${escapeRegExp(base)}(/|$| )`;
      }
    }
    const prefix = derivePrefix(worktrees);
    if (prefix !== undefined) {
      return `${escapeRegExp(prefix)}${escapeRegExp(lane)}(/|$| )`;
    }
  }
  return `cf-${escapeRegExp(lane)}(/|$| )`;
}

/**
 * `gate-<lane>.log` is round 0; `gate-<lane>-<n>.log` is round n. Highest n
 * wins — not lexicographic order, where `-` (45) sorts before `.` (46) and
 * `gate-u2.log` would beat `gate-u2-2.log`.
 */
function newestGateLog(entries: readonly string[], lane: string): string | undefined {
  const re = new RegExp(`^gate-${escapeRegExp(lane)}(?:-(\\d+))?\\.log$`);
  let bestName: string | undefined;
  let bestRound = -1;
  for (const entry of entries) {
    const match = re.exec(entry);
    if (match === null) continue;
    const round = match[1] === undefined ? 0 : Number(match[1]);
    if (round > bestRound) {
      bestRound = round;
      bestName = entry;
    }
  }
  return bestName;
}
