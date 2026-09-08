import { execFile } from "node:child_process";
import { readdir as fsReaddir, readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { join } from "node:path";
import { readEvents } from "./events.js";
import { mergeStatus } from "./merge.js";
import type { LaneObservation, WaveEvent, WaveStatus } from "./types.js";

/**
 * The process-facing side of collection. Everything impure is behind this
 * interface — `collect` itself only orchestrates, so tests drive it through
 * stubs and never touch the filesystem or the network.
 */
export interface CollectDeps {
  readonly readdir: (dir: string) => Promise<readonly string[]>;
  readonly readFile: (path: string) => Promise<string>;
  readonly stat: (path: string) => Promise<{ readonly size: number; readonly mtimeMs: number }>;
  readonly pgrep: (pattern: string) => Promise<number>;
  readonly gh: (args: readonly string[]) => Promise<string>;
}

/** Wave log directories live directly under here: `/tmp/wave*`. */
export const WAVE_LOG_ROOT = "/tmp";

/** How much of a lane log travels with the observation (the EXIT marker lives at the end). */
const LOG_TAIL_BYTES = 16 * 1024;

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
 */
export async function collect(deps: CollectDeps, root: string, now: string): Promise<WaveStatus> {
  const events: WaveEvent[] = [];
  const observed: Record<string, LaneObservation> = {};

  const prByLane = await prFacts(deps);

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
        const [text, st] = await Promise.all([deps.readFile(logPath), deps.stat(logPath)]);
        log = { bytes: st.size, mtimeMs: st.mtimeMs, tail: text.slice(-LOG_TAIL_BYTES) };
      } catch {
        log = undefined;
      }

      let alive = false;
      try {
        alive = (await deps.pgrep(`wt-${lane}`)) > 0;
      } catch {
        alive = false;
      }

      const gateName = entries
        .filter((entry) => entry.startsWith(`gate-${lane}`) && entry.endsWith(".log"))
        .sort()
        .at(-1);
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
 * One `gh pr list` per collection, plus check-runs for open heads, mapped to
 * lanes by branch name `feat/<lane>`. Any `gh` failure yields no PRs.
 */
async function prFacts(deps: CollectDeps): Promise<Record<string, LaneObservation["pr"]>> {
  const byLane: Record<string, LaneObservation["pr"]> = {};

  let listed: readonly GhPrListEntry[];
  try {
    const out = await deps.gh([
      "pr",
      "list",
      "--state",
      "all",
      "--json",
      "number,state,headRefName,headRefOid",
    ]);
    listed = JSON.parse(out) as readonly GhPrListEntry[];
  } catch {
    return byLane;
  }

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
        continue;
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

/** The deps the real server runs with: the actual filesystem, `pgrep` and `gh`. */
export const realDeps: CollectDeps = {
  readdir: (dir) => fsReaddir(dir),
  readFile: (path) => fsReadFile(path, "utf8"),
  stat: (path) => fsStat(path).then((st) => ({ size: st.size, mtimeMs: st.mtimeMs })),
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
};

function countPids(stdout: string): number {
  return stdout.split("\n").filter((line) => line.trim() !== "").length;
}
