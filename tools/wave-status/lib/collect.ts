import { execFile } from "node:child_process";
import { open as fsOpen, readdir as fsReaddir, readFile as fsReadFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { readEvents } from "./events.js";
import { mergeStatus } from "./merge.js";
import { readBacklog } from "./backlog.js";
import { artifactPathFor } from "../../plan-verify/lib/artifact.js";
import type { LaneObservation, PrChecks, WaveEvent, WaveStatus } from "./types.js";

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
  readonly planVerifyArtifactPath?: string;
}

/** Wave log directories live directly under here: `~/.waves/wave*`. */
export const WAVE_LOG_ROOT = join(homedir(), ".waves");

/** Legacy root: in-flight waves from earlier runs are preserved here. */
export const LEGACY_WAVE_LOG_ROOT = "/tmp";

/** How much of a lane log travels with the observation (the EXIT marker lives at the end). */
export const LOG_TAIL_BYTES = 16 * 1024;

/** Public `?tail=` is in KB; anything above this is 400, not an unbounded read. */
export const MAX_TAIL_KB = 1024;

/** Prefixed families are pipeline artefacts, not lane logs. */
const LANE_LOG_EXCLUDED = /^(install|gate|review|fix|q)-/;

/**
 * A lane's log is named `<lane>.log` after the lane itself — the name
 * `dispatch-lane.sh` writes and the branch tail the PR join reads. A log whose
 * name *appends* the kind of run it holds — `c4b-install.log`, `x15-fix.log`,
 * `s2fix.log`, `hl5e-runner.log`, `oc-probe.log`, `x16-tc.log` — describes a
 * lane that ran elsewhere. The lookbehind keeps a lane whose own name ends in
 * those letters (`prefix`, `uninstall`) out of the net.
 */
const LANE_LOG_ARTIFACT = /(?<![a-zA-Z])(gate|install|review|probe|runner|brief|metrics|tc|fix\d*)$/;

/**
 * Characters a git branch tail can never contain. A log named with one of
 * these (`gate-c4-lint:arch.log`, `weird name.log`) cannot name a lane either.
 */
const NOT_A_BRANCH_TAIL = /[\s:~^*?[\]\\]/;

/**
 * The evidence rule for a log-derived lane, stated once because everything
 * downstream rests on it: a row exists for a lane the page has evidence for —
 * an event that names it, or a `.log` named by the lane/branch convention and
 * not marked as an artefact of some run. A wave directory's other files are
 * the orchestrator's working litter (gate rounds, fix transcripts, probe
 * output), and counting them as lanes is how one session's log spam rendered
 * as "113 lanes, 102 vanished". A future artefact family must be ignored by
 * this rule, never blacklisted by name after the page lied again.
 */
export function namesALaneLog(entry: string): boolean {
  if (!entry.endsWith(".log")) return false;
  const name = entry.slice(0, -".log".length);
  return (
    !LANE_LOG_EXCLUDED.test(name) &&
    !LANE_LOG_ARTIFACT.test(name) &&
    !NOT_A_BRANCH_TAIL.test(name)
  );
}

/**
 * One PR as the collector sees it: the observation's facts plus the
 * normalised branch tail (`headRefName` minus any `feat/`-style prefix,
 * lowercased) that the fallback join runs on. The lane's own event `pr`
 * number is the preferred join; the tail is only a fallback.
 */
export interface PrFact extends NonNullable<LaneObservation["pr"]> {
  readonly branchTail: string;
}

/**
 * The heads the wave actually names. `prFacts` fetches check-runs only for the
 * open PRs a lane claims — the event's own `pr`, or a branch tail some lane
 * matches — so the sweep grows with the wave, not with the repository.
 */
export interface PrScope {
  readonly lanes: ReadonlySet<string>;
  readonly reportedPrs: ReadonlySet<number>;
}

/**
 * What one `gh` PR listing parsed to. `skipped` counts the rows that came back
 * but could not be read — a truncated last line, a row the projection dropped
 * a field from. A skipped row is a gap in the corpus and is never a reason to
 * discard the rows that did read: one malformed entry emptying the batch is
 * the same fault as a missing page, and it looks like a repository with no
 * pull requests at all.
 */
export interface PrListParse {
  readonly entries: readonly GhPrListEntry[];
  readonly skipped: number;
}

/**
 * The corpus `prFacts` read: the facts it could build, and the rows it could
 * not. The two travel together so a partial corpus can never be mistaken for a
 * whole one downstream.
 */
export interface PrCorpus {
  readonly facts: readonly PrFact[];
  readonly skipped: number;
}

interface GhPrListEntry {
  readonly number: number;
  readonly state: string;
  readonly headRefName: string;
  readonly headRefOid: string;
  /**
   * The full `owner/name` of the repository the listing came from, carried by
   * every real pull object. Optional because older recorded corpora predate
   * the projection: a corpus without it cannot address the thread query, and
   * its open PRs carry "unknown" threads rather than a silent zero.
   */
  readonly repo?: string | null;
}

export function waveIdFromDirName(name: string): string {
  return name.replace(/^wave-?/, "");
}

export function resolveScanRoots(
  root: string,
  legacyRoots?: readonly string[],
): readonly string[] {
  const scanRoots = [root];
  const resolvedLegacy = legacyRoots ?? (root === WAVE_LOG_ROOT ? [LEGACY_WAVE_LOG_ROOT] : []);
  for (const legacy of resolvedLegacy) {
    if (!scanRoots.includes(legacy)) {
      scanRoots.push(legacy);
    }
  }
  return scanRoots;
}

/**
 * Walk the wave log tree and build the one `WaveStatus` the server renders.
 * Failing reads shrink the observation (no log, no gate). A `gh` failure rejects
 * so PR facts are never silently dropped as an empty list (which would falsely
 * indicate no pull requests exist).
 *
 * `knownCorpus`, when provided, is reused as-is — rows and gap together: a
 * watcher-triggered refresh re-reads local state without waiting on `gh`, and
 * the corpus it reuses is exactly as complete as the one it was read as. Omit
 * it (or pass nothing) to fetch PR facts now — startup, the slow poll,
 * on-demand. When fetched, the corpus is handed to `onCorpus` so the caller
 * can cache it for the next watcher refresh.
 */
export async function collect(
  deps: CollectDeps,
  root: string,
  now: string,
  knownCorpus?: PrCorpus,
  legacyRoots?: readonly string[],
  onCorpus?: (corpus: PrCorpus) => void,
): Promise<WaveStatus> {
  // Gather first, order last: the wave list is decided here, the one place
  // that has seen every lane log's mtime, and it travels to the merge as an
  // explicit order. Feeds are never asked to carry it — grouping by feed is
  // how an evented old wave came to lead a live new one.
  const rows: {
    readonly wave: string;
    readonly lane: string;
    readonly reportedPr: number | undefined;
    readonly obs: Omit<LaneObservation, "pr">;
  }[] = [];
  const events: WaveEvent[] = [];
  const newestByWave = new Map<string, number>();
  const discovered = new Set<string>();
  // The heads the wave names, gathered while scanning. `prFacts` uses them to
  // fetch check-runs only for open PRs a lane claims, not every open head in
  // the repository.
  const lanes = new Set<string>();
  const reportedPrs = new Set<number>();

  const worktrees = await worktreeFacts(deps);

  const scanRoots = resolveScanRoots(root, legacyRoots);

  for (const scanRoot of scanRoots) {
    let dirNames: readonly string[];
    try {
      dirNames = await deps.readdir(scanRoot);
    } catch {
      continue;
    }

    // Lexicographic is not the output order — it is the stable base the output
    // order is a permutation of: waves of equal (or absent) newest activity must
    // come out in a deterministic order, not readdir's.
    const waveDirs = dirNames.filter((name) => name.startsWith("wave")).sort();
    for (const name of waveDirs) {
      const wave = waveIdFromDirName(name);
      if (discovered.has(wave)) continue;

      const dir = join(scanRoot, name);
      let entries: readonly string[];
      try {
        entries = await deps.readdir(dir);
      } catch {
        continue;
      }
      // Discovered is enough to list it: a wave directory with no lane log and
      // no events yet is a dispatched wave, and that is the state an operator
      // most wants to see. Absent is the one answer that is never useful.
      discovered.add(wave);

      // Events are read before the lane logs because a lane's own event `pr`
      // is the preferred join key: the directory that holds a log also holds
      // the events reporting that log's PR, whatever its wave field says.
      // Every lane an event names is also a lane of this directory — dispatch
      // through the Agent tool writes events and no lane log at all, and a
      // lane that reaches no row gets neither the probe nor the PR join.
      const reportedPrByLane = new Map<string, number>();
      const eventLanes = new Set<string>();
      if (entries.includes("events.jsonl")) {
        try {
          const text = await deps.readFile(join(dir, "events.jsonl"));
          for (const event of readEvents(text).events) {
            events.push(event);
            eventLanes.add(event.lane);
            if (event.pr !== undefined) reportedPrByLane.set(event.lane, event.pr);
          }
        } catch {
          // W3 writes events.jsonl; absent or unreadable is "nobody reported", not an error.
        }
      }

      const laneLogs = entries.filter(namesALaneLog).sort();
      for (const fileName of laneLogs) {
        const lane = fileName.slice(0, -".log".length);
        const logPath = join(dir, fileName);

        let log: LaneObservation["log"];
        try {
          const part = await readTail(deps.open, logPath, LOG_TAIL_BYTES);
          log = { bytes: part.size, mtimeMs: part.mtimeMs, tail: part.tail.toString("utf8") };
          const prior = newestByWave.get(wave);
          if (prior === undefined || part.mtimeMs > prior) newestByWave.set(wave, part.mtimeMs);
        } catch {
          log = undefined;
        }

        const reportedPr = reportedPrByLane.get(lane);
        lanes.add(lane);
        if (reportedPr !== undefined) reportedPrs.add(reportedPr);
        const obs = await buildObservation(deps, dir, entries, lane, worktrees, log);
        rows.push({ wave, lane, reportedPr, obs });
      }

      // The second source: lanes an event named that wrote no log. They are
      // lanes, so they get the row's observations — the same shared build the
      // log loop uses, probe, gate and all, and the same PR join every row
      // goes through. Without this push an event-only lane is merged as
      // `{ alive: false }` with no probe behind it: a default wearing the
      // mask of a measurement.
      const loggedLanes = new Set(laneLogs.map((f) => f.slice(0, -".log".length)));
      for (const lane of [...eventLanes].sort()) {
        if (loggedLanes.has(lane)) continue;
        const obs = await buildObservation(deps, dir, entries, lane, worktrees);
        const reportedPr = reportedPrByLane.get(lane);
        lanes.add(lane);
        if (reportedPr !== undefined) reportedPrs.add(reportedPr);
        rows.push({ wave, lane, reportedPr, obs });
      }
    }
  }

  // The join needs the facts, and the facts need the lanes — so fetch only now
  // that every lane and every reported `pr` has been gathered. A watcher
  // refresh hands the cached facts in and this call is skipped entirely.
  let corpus = knownCorpus;
  if (corpus === undefined) {
    corpus = await prFacts(deps, { lanes, reportedPrs });
    onCorpus?.(corpus);
  }
  const facts = corpus.facts;

  // The wave list order, decided once from the newest lane-log activity in each
  // wave, is handed to the merge as data — not implied by the order two feeds
  // happen to be walked in. Waves it cannot date keep the lexicographic base.
  const orderedWaves = [...discovered].sort((a, b) =>
    compareRecency(newestByWave.get(a), newestByWave.get(b)),
  );

  const observed: Record<string, LaneObservation> = {};
  for (const row of rows) {
    const pr = joinPrForLane(row.lane, row.reportedPr, facts);
    observed[`${row.wave}/${row.lane}`] = { ...row.obs, ...(pr !== undefined ? { pr } : {}) };
  }

  const status = mergeStatus(events, observed, now, orderedWaves);
  const backlogPath = deps.planVerifyArtifactPath ?? artifactPathFor(process.env, root);
  const backlog = await readBacklog(deps.readFile, backlogPath);
  const withBacklog: WaveStatus = { ...status, backlog };
  // A corpus with rows missing is not one the page may read as complete: a
  // lane that joined no PR may be a lane whose PR was in an unreadable row.
  // Name the gap so no face of this tool can render it as "no PR".
  return corpus.skipped > 0 ? { ...withBacklog, prs: { skipped: corpus.skipped } } : withBacklog;
}

/**
 * The observation both row sources build: one probe, one gate lookup, one
 * assembly — so a field one source carries cannot be missing from the other.
 * Two copies of this block are how an event-only lane lost its gate exit and
 * its coverage while `gate-<lane>.log` sat beside its events: the loop that
 * found the lane forgot the lookup the other loop had.
 */
async function buildObservation(
  deps: CollectDeps,
  dir: string,
  entries: readonly string[],
  lane: string,
  worktrees: readonly string[],
  log?: LaneObservation["log"],
): Promise<Omit<LaneObservation, "pr">> {
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

  return {
    ...(log !== undefined ? { log } : {}),
    ...(gateLog !== undefined ? { gateLog } : {}),
    alive,
  };
}

/**
 * Wave order by newest lane-log activity: newer first; a wave nothing could
 * date sinks below every dated one; undated-vs-undated and equal mtimes keep
 * the discovered (lexicographic) order — Array#sort is stable.
 */
function compareRecency(a: number | undefined, b: number | undefined): number {
  if (a === undefined) return b === undefined ? 0 : 1;
  if (b === undefined) return -1;
  return b - a;
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
 * Projection from REST API pull object to the GhPrListEntry shape prFacts consumes.
 * Maps .head.ref to headRefName, .head.sha to headRefOid, normalises merged state,
 * and carries the base repository's full name — the thread query addresses a repo
 * by name, and this way the sweep never pays a call just to learn its own.
 */
export const PR_PULLS_JQ =
  '.[] | {number: .number, state: (if .merged_at then "merged" else .state end), headRefName: .head.ref, headRefOid: .head.sha, repo: .base.repo.full_name}';

/**
 * The PR corpus, walked through the REST API. `gh api` with `--paginate`
 * follows Link headers and streams every PR in the repository, projecting each
 * to `{number, state, headRefName, headRefOid}` via jq.
 *
 * `scope`, when provided, bounds the check-runs sweep to the open heads a lane
 * actually claims: the event's own `pr`, or a branch tail some lane matches.
 * An unclaimed open PR is still listed (checks none) but costs no `api` call —
 * so a refresh grows with the wave, not with every open PR in the repository.
 * Omit `scope` to fetch checks for every open head (the standalone behaviour).
 *
 * Nothing here returns an unmarked empty corpus to mean "the read failed". A
 * `gh` failure throws ("could not fetch PRs") because the fetch did not
 * happen — an empty corpus there would be indistinguishable from a repository
 * with no pull requests. Rows that came back but cannot be read are skipped
 * and carried in `skipped`, so a corpus with a hole in it is never one the
 * page may read as whole.
 */
export async function prFacts(deps: CollectDeps, scope?: PrScope): Promise<PrCorpus> {
  let stdout: string;
  try {
    stdout = await deps.gh([
      "api",
      "repos/{owner}/{repo}/pulls?state=all&per_page=100",
      "--paginate",
      "--jq",
      PR_PULLS_JQ,
    ]);
  } catch (error) {
    throw new Error(
      `could not fetch PRs: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  // Rows `gh` returned that nothing could read are counted here and travel
  // with the corpus. `gh` ran — the failure to *fetch* is the throw above —
  // so the answer is not a crash but a corpus that is not whole, which the
  // page must render as a short read rather than as no pull requests.
  const listed = parsePrList(stdout);

  // One read-only thread query for every open PR — never a call per PR. Its
  // counts land on the open facts; anything it could not reach is "unknown".
  const threadCounts = await threadCountsByPr(deps, listed.entries);

  const facts: PrFact[] = [];
  for (const entry of listed.entries) {
    const state = entry.state.toLowerCase();
    if (state !== "open" && state !== "merged" && state !== "closed") continue;

    // The initial value is the honest one: nothing has been asked yet, so
    // this is "could not ask", not "no checks have run". `none` is earned
    // only by a read that came back and found no Build runs.
    let checks: PrChecks = "unknown";
    if (state === "open" && (scope === undefined || isClaimed(entry, scope))) {
      try {
        checks = parseChecks(
          await deps.gh(["api", `repos/:owner/:repo/commits/${entry.headRefOid}/check-runs`]),
        );
      } catch {
        // Transient check-runs failure: keep the PR, and say the read failed
        // rather than letting the default masquerade as a measurement.
        checks = "unknown";
      }
    }

    facts.push({
      number: entry.number,
      state,
      checks,
      ...(state === "open"
        ? { unresolvedThreads: threadCounts.get(entry.number) ?? "unknown" }
        : {}),
      branchTail: branchTail(entry.headRefName),
    });
  }

  return { facts, skipped: listed.skipped };
}

/**
 * Does some lane claim this open head — as its event `pr`, or a branch tail an
 * exact/descendant lane match would reach? A superset of what the join can pick
 * is fine: an over-broad yes only costs one check-runs call, whereas the
 * repository's unrelated open PRs cost none.
 */
function isClaimed(entry: GhPrListEntry, scope: PrScope): boolean {
  if (scope.reportedPrs.has(entry.number)) return true;
  const tail = branchTail(entry.headRefName);
  for (const lane of scope.lanes) {
    const needle = lane.toLowerCase();
    if (tail === needle || tail.startsWith(`${needle}-`)) return true;
  }
  return false;
}

/** `feat/l3b-layer-props` → `l3b-layer-props`; `main` → `main`. Lowercased. */
function branchTail(headRefName: string): string {
  const slash = headRefName.lastIndexOf("/");
  return (slash === -1 ? headRefName : headRefName.slice(slash + 1)).toLowerCase();
}

/**
 * The read-only GraphQL search that counts the unresolved review threads of
 * every open PR in the repository in ONE query — never a call per PR, and
 * never the prose of a thread: counts and states only, because why a thread
 * is open lives in the thread. `first: 100` per page, continued by cursor,
 * which is the same pagination the PR listing already performs; a per-head
 * call would double the sweep and is refused outright by the plan.
 */
const PR_THREADS_QUERY = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 100, after: $after) {
    nodes {
      ... on PullRequest {
        number
        reviewThreads(first: 100) {
          pageInfo { hasNextPage }
          nodes { isResolved }
        }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

/** Narrow an unknown JSON value to an object (arrays included: their missing keys just miss). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * One map of PR number to unresolved-thread count for the whole sweep:
 * `number` when the single query answered it, `"unknown"` when the answer
 * was truncated or unreadable, and absent from the map — which downstream
 * reads as "unknown" too — when the query could not run at all. A gh failure
 * never rejects: the PR facts stand without threads; a thread read that
 * could not be taken is a value, not a crash.
 */
async function threadCountsByPr(
  deps: CollectDeps,
  entries: readonly GhPrListEntry[],
): Promise<ReadonlyMap<number, number | "unknown">> {
  const counts = new Map<number, number | "unknown">();
  if (!entries.some((entry) => entry.state.toLowerCase() === "open")) return counts;
  // The thread query addresses a repository by name. The listing carries it
  // on every real row; a corpus whose rows all lost the field cannot address
  // the query — so it is not run, and its opens honestly read "unknown".
  let repo: string | undefined;
  for (const entry of entries) {
    if (typeof entry.repo === "string") {
      repo = entry.repo;
      break;
    }
  }
  if (repo === undefined) return counts;
  let cursor: string | undefined;
  for (;;) {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${PR_THREADS_QUERY}`,
      "-f",
      `q=repo:${repo} is:pr is:open`,
    ];
    if (cursor !== undefined) args.push("-f", `after=${cursor}`);
    let stdout: string;
    try {
      stdout = await deps.gh(args);
    } catch {
      // A page that did not arrive adds no counts. What is already in hand
      // stands — the walk stops, and every open PR missing from the map is
      // "unknown" downstream, never a silent zero.
      return counts;
    }
    const page = parseThreadPage(stdout);
    if (page === undefined) return counts;
    for (const [number, count] of page.counts) counts.set(number, count);
    if (!page.hasNextPage || page.endCursor === undefined) return counts;
    if (page.endCursor === cursor) return counts;
    cursor = page.endCursor;
  }
}

interface ThreadPage {
  readonly counts: ReadonlyMap<number, number | "unknown">;
  readonly hasNextPage: boolean;
  readonly endCursor?: string;
}

/** `undefined` for a response whose shape nothing can stand on. */
function parseThreadPage(json: string): ThreadPage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isRecord(parsed.data)) return undefined;
  const search = parsed.data.search;
  if (!isRecord(search) || !Array.isArray(search.nodes) || !isRecord(search.pageInfo)) {
    return undefined;
  }
  const counts = new Map<number, number | "unknown">();
  for (const node of search.nodes) {
    if (!isRecord(node) || typeof node.number !== "number") continue;
    const threads = node.reviewThreads;
    if (!isRecord(threads) || !Array.isArray(threads.nodes) || !isRecord(threads.pageInfo)) {
      continue;
    }
    if (typeof threads.pageInfo.hasNextPage !== "boolean") {
      counts.set(node.number, "unknown");
      continue;
    }
    counts.set(
      node.number,
      threads.pageInfo.hasNextPage === true
        ? "unknown"
        : threads.nodes.filter(isUnresolvedThread).length,
    );
  }
  return {
    counts,
    hasNextPage: search.pageInfo.hasNextPage === true,
    ...(typeof search.pageInfo.endCursor === "string"
      ? { endCursor: search.pageInfo.endCursor }
      : {}),
  };
}

function isUnresolvedThread(thread: unknown): boolean {
  return isRecord(thread) && thread.isResolved === false;
}

/**
 * The PR for one lane: the lane's own reported `pr` number if the events
 * carry one and `gh` knows that PR; otherwise the best normalised branch
 * match — an exact case-folded tail, then a `<lane>-` descendant, and among
 * equals the newest PR. `null` is the answer when neither exists.
 */
export function joinPrForLane(
  lane: string,
  eventPr: number | undefined,
  facts: readonly PrFact[],
): LaneObservation["pr"] | undefined {
  if (eventPr !== undefined) {
    const reported = facts.find((fact) => fact.number === eventPr);
    if (reported !== undefined) return asPr(reported);
  }

  const wanted = lane.toLowerCase();
  let best: PrFact | undefined;
  let bestScore = 0;
  for (const fact of facts) {
    const score =
      fact.branchTail === wanted ? 2 : fact.branchTail.startsWith(`${wanted}-`) ? 1 : 0;
    if (score === 0) continue;
    if (best === undefined || score > bestScore || (score === bestScore && fact.number > best.number)) {
      best = fact;
      bestScore = score;
    }
  }
  return best === undefined ? undefined : asPr(best);
}

function asPr(fact: PrFact): LaneObservation["pr"] {
  return {
    number: fact.number,
    state: fact.state,
    checks: fact.checks,
    ...(fact.unresolvedThreads === undefined
      ? {}
      : { unresolvedThreads: fact.unresolvedThreads }),
  };
}

/**
 * The check conclusions keyed on the runs this pipeline cares about — the
 * ones named `Build`. No Build runs → none (we asked, and nothing has run);
 * any unfinished → pending; any failed → fail; otherwise pass. A response
 * that cannot be read is unknown — *could not ask*, never a silent none:
 * bad JSON used to wear the same word as an empty list. Never a throw.
 */
export function parseChecks(json: string): PrChecks {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return "unknown";
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.check_runs)) return "unknown";
  const builds = parsed.check_runs.filter(
    (run) => isRecord(run) && typeof run.name === "string" && /^Build/.test(run.name),
  );
  if (builds.length === 0) return "none";
  if (
    builds.some(
      (run) =>
        (run as { readonly status?: unknown }).status !== "completed" ||
        (run as { readonly conclusion?: unknown }).conclusion === null,
    )
  ) {
    return "pending";
  }
  if (builds.some((run) => (run as { readonly conclusion?: unknown }).conclusion !== "success")) {
    return "fail";
  }
  return "pass";
}

/**
 * Parse PR list output. Supports both a single JSON array (e.g. from test
 * fixtures) and newline-delimited JSON (NDJSON streamed by `gh api --paginate
 * --jq '.[] | ...'`). A row is kept when it is an entry of `{number, state,
 * headRefName, headRefOid}`; any other row — unparseable, truncated, missing a
 * field — is skipped and counted, never allowed to discard the batch with it.
 */
export function parsePrList(stdout: string): PrListParse {
  const trimmed = stdout.trim();
  if (trimmed === "") return { entries: [], skipped: 0 };

  // One array is one batch; anything else is read a row per line. A failed
  // array parse falls through the same way — a truncated array is rows.
  const array = trimmed.startsWith("[") ? tryParseJson(trimmed) : undefined;
  const rows: readonly unknown[] = Array.isArray(array)
    ? array
    : trimmed.split("\n").filter((line) => line.trim() !== "");

  const entries: GhPrListEntry[] = [];
  let skipped = 0;
  for (const row of rows) {
    const parsed = typeof row === "string" ? tryParseJson(row) : row;
    if (isGhPrListEntry(parsed)) {
      entries.push(parsed);
    } else {
      skipped += 1;
    }
  }
  return { entries, skipped };
}

/** `undefined` for anything `JSON.parse` rejects — including the row that was cut in half. */
function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isGhPrListEntry(value: unknown): value is GhPrListEntry {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.number === "number" &&
    typeof rec.state === "string" &&
    typeof rec.headRefName === "string" &&
    typeof rec.headRefOid === "string" &&
    // The repo the thread query needs: absent or null reads as "no repo on
    // this row" (older corpora, or a projection that lost it). Any other
    // type is a row nothing can stand on.
    (rec.repo === undefined || rec.repo === null || typeof rec.repo === "string")
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
    const base = basename(wt);
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
      const base = basename(wt);
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
