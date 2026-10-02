import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DerivedLane, LaneStatus, WaveStatus } from "./types.js";

/** This repository's project id, sent to the client as `WAVES_PROJECT` when the environment names none. */
export const DEFAULT_WAVES_PROJECT = "campaign-foundry";

/** A wave nobody has touched in a week is history; a default push never names it. */
export const RECENT_WAVE_MS = 7 * 24 * 60 * 60 * 1000;

/** The service allows one write per second per project, so two pushes of one tick wait longer than that. */
export const PUSH_SPACING_MS = 1_100;

/** The longest interval the client accepts, and so the longest a wave may go unrefreshed. */
export const MAX_INTERVAL_SECONDS = 300;

/**
 * The client's own id rule, held in one place because two callers must agree
 * with the service rather than with each other: the CLI refuses what the service
 * would refuse, and `selectWaves` skips what a log directory yielded anyway.
 */
export const WAVE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

/**
 * The installed `waves` client, by its pinned path — never a shell, never a
 * search. D106 allows this one subprocess, in `push.ts` and nowhere else.
 */
export const WAVES_BIN = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../node_modules/.bin/waves",
);

export interface PushRun {
  readonly code: number;
  readonly stderr: string;
}

export interface PushDeps {
  /**
   * Runs the waves client with these arguments and this stdin; resolves with its
   * exit code and stderr. Rejects only when the process could not be started.
   */
  readonly run: (args: readonly string[], stdin: string) => Promise<PushRun>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly warn: (text: string) => void;
  readonly nowMs: () => number;
  /**
   * What has already been said to `warn` by an earlier call, when the caller
   * keeps the memory. A refused wave id or lane is the same sentence every tick
   * and must not scroll past the operator once an interval; a push that failed
   * is news each time and never consults this.
   */
  readonly warned?: Set<string>;
}

export interface PushOptions {
  /** Wave ids named with --wave; empty means "the recent ones". */
  readonly waves: readonly string[];
  /** The --watch seconds, or false for a one-shot push. */
  readonly watch: number | false;
}

/**
 * `reported` as the service accepts it. Not `lane.reported` itself: the shape is
 * closed, so `wave` and `lane` — which the collector's own event carries and a
 * reader of the page would expect here — would refuse the whole wave.
 */
function pushReported(reported: NonNullable<LaneStatus["reported"]>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    stage: reported.stage,
    event: reported.event,
    ts: reported.ts,
  };
  if (reported.pr !== undefined) out.pr = reported.pr;
  if (reported.round !== undefined) out.round = reported.round;
  if (reported.detail !== undefined) out.detail = reported.detail;
  return out;
}

/** `derived.pr`: four keys, each left out when the read did not read it. */
function pushPr(pr: NonNullable<DerivedLane["pr"]>): Record<string, unknown> {
  const out: Record<string, unknown> = { number: pr.number, state: pr.state, checks: pr.checks };
  if (pr.unresolvedThreads !== undefined) out.unresolvedThreads = pr.unresolvedThreads;
  return out;
}

/** `derived.gate.coverage`: four numbers, no key the collector ever adds. */
function pushCoverage(
  coverage: NonNullable<NonNullable<DerivedLane["gate"]>["coverage"]>,
): Record<string, unknown> {
  return {
    statements: coverage.statements,
    branches: coverage.branches,
    functions: coverage.functions,
    lines: coverage.lines,
  };
}

/** `derived.gate`: the exit, and the coverage when the gate reported one. */
function pushGate(gate: NonNullable<DerivedLane["gate"]>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (gate.exit !== undefined) out.exit = gate.exit;
  if (gate.coverage !== undefined) out.coverage = pushCoverage(gate.coverage);
  return out;
}

/** `derived.diff`: three counts. */
function pushDiff(diff: NonNullable<DerivedLane["diff"]>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (diff.files !== undefined) out.files = diff.files;
  if (diff.insertions !== undefined) out.insertions = diff.insertions;
  if (diff.deletions !== undefined) out.deletions = diff.deletions;
  return out;
}

/**
 * `derived` as the client accepts it: a whitelist of eight keys, each left out
 * when the lane never gathered it. Never a spread of `lane.derived` — a key
 * `DerivedLane` gains later must not reach the wire by accident, which is the
 * only thing this list is for. Neither may a nested shape: the service closes
 * `pr`, `gate`, `gate.coverage` and `diff` too.
 */
function pushDerived(lane: DerivedLane): Record<string, unknown> {
  const out: Record<string, unknown> = { alive: lane.alive };
  if (lane.exit !== undefined) out.exit = lane.exit;
  if (lane.gate !== undefined) out.gate = pushGate(lane.gate);
  if (lane.pr !== undefined) out.pr = pushPr(lane.pr);
  if (lane.diff !== undefined) out.diff = pushDiff(lane.diff);
  // The tail never goes: the client strips it anyway, and it is up to 16 KiB a lane.
  if (lane.log !== undefined) out.log = { bytes: lane.log.bytes, mtimeMs: lane.log.mtimeMs };
  if (lane.planReview !== undefined) out.planReview = lane.planReview;
  if (lane.risk !== undefined) out.risk = lane.risk;
  return out;
}

/**
 * The one wave's `{"lanes":[…]}` body. `wave` is the `--wave` argument, so it is
 * never a lane key.
 *
 * A lane whose id the service would refuse is left out and named, because the
 * envelope is refused whole: one `-lead` — an id `scripts/wave-event.sh` accepts
 * — would cost every other lane of its wave its update on every tick.
 */
export function toPushLanes(
  lanes: readonly LaneStatus[],
  warn: (text: string) => void,
): { readonly lanes: readonly unknown[] } {
  return {
    lanes: lanes.flatMap((lane) => {
      if (!WAVE_ID_PATTERN.test(lane.lane)) {
        warn(
          `waves push: skipping lane ${JSON.stringify(lane.lane)}: the service would refuse that id`,
        );
        return [];
      }
      return [
        {
          id: lane.lane,
          ...(lane.seat === undefined ? {} : { seat: lane.seat }),
          ...(lane.reported === undefined ? {} : { reported: pushReported(lane.reported) }),
          derived: pushDerived(lane.derived),
          disagreements: lane.disagreements,
        },
      ];
    }),
  };
}

/** The newest *dated* fact about a wave's lanes, or `undefined` when none carries one. */
function waveActivityMs(lanes: readonly LaneStatus[]): number | undefined {
  const times: number[] = [];
  for (const lane of lanes) {
    const logMs = lane.derived.log?.mtimeMs;
    if (typeof logMs === "number") times.push(logMs);
    if (lane.reported !== undefined) {
      const ts = Date.parse(lane.reported.ts);
      // An unparseable ts is silence, never a zero that reads as "the epoch".
      if (!Number.isNaN(ts)) times.push(ts);
    }
  }
  return times.length === 0 ? undefined : Math.max(...times);
}

/** A wave with activity in the last `RECENT_WAVE_MS`; one with nothing datable never is. */
function isRecent(lanes: readonly LaneStatus[], nowMs: number): boolean {
  const activity = waveActivityMs(lanes);
  return activity !== undefined && nowMs - activity <= RECENT_WAVE_MS;
}

/**
 * The waves a push may draw from. A wave with no lanes has nothing to say, and a
 * wave whose id the service would refuse is skipped — but it is named only when
 * it would otherwise have gone out: one stale log directory with a bad name is
 * not the operator's news, once a tick, for the length of a `--watch`.
 */
export function selectWaves(
  status: WaveStatus,
  options: PushOptions,
  nowMs: number,
  warn: (text: string) => void,
): WaveStatus["waves"] {
  const named = new Set(options.waves);
  const pushable = new Set<string>();
  const refused = new Set<string>();
  for (const wave of status.waves) {
    const inScope = named.size === 0 ? isRecent(wave.lanes, nowMs) : named.has(wave.id);
    if (!WAVE_ID_PATTERN.test(wave.id)) {
      refused.add(wave.id);
      if (inScope) {
        warn(
          `waves push: skipping wave ${JSON.stringify(wave.id)}: the service would refuse that id`,
        );
      }
    } else if (wave.lanes.length > 0 && inScope) {
      pushable.add(wave.id);
    }
  }

  if (named.size === 0) return status.waves.filter((wave) => pushable.has(wave.id));

  // A Set, so one line per DISTINCT id the operator named and never one per
  // repetition of it — and an id already named as refused is not named again.
  for (const id of named) {
    if (!pushable.has(id) && !refused.has(id)) {
      warn(`waves push: --wave ${JSON.stringify(id)} names no wave with lanes to push`);
    }
  }
  return status.waves.filter((wave) => pushable.has(wave.id));
}

/** What one wave really waits between two of its own pushes: the watch interval plus this tick's spacing. */
function spacingSeconds(watch: number, waveCount: number): number {
  return watch + Math.ceil((waveCount * PUSH_SPACING_MS) / 1000);
}

/**
 * The interval to report: how long one wave really waits between two of its own
 * pushes, which is what the server uses to decide a wave has gone stale — capped
 * at what the client accepts.
 */
export function intervalFor(watch: number | false, waveCount: number): number | undefined {
  return watch === false
    ? undefined
    : Math.min(MAX_INTERVAL_SECONDS, spacingSeconds(watch, waveCount));
}

/** How much of another program's stderr one warn line may carry. */
const STDERR_CHARS = 300;

/**
 * Another program's text, cut down to a line a human reads in a watch loop: the
 * first three non-empty lines, trimmed, joined with ` | `, and never more than
 * `STDERR_CHARS` characters of the whole.
 */
function excerpt(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(0, 3)
    .join(" | ")
    .slice(0, STDERR_CHARS);
}

/** A run the client refused: the wave, the exit code, and what it said about it. */
function refusedLine(waveId: string, code: number, stderr: string): string {
  return `waves push: ${waveId}: exit ${code}: ${excerpt(stderr)}`;
}

/** A run that never started: there is no exit code to report, only why. */
function unrunnableLine(waveId: string, message: string): string {
  return `waves push: ${waveId}: ${excerpt(message)}`;
}

/** D197: a push failure warns and never fails a stage, so a warn that throws is swallowed here. */
function quietly(warn: (text: string) => void, text: string): void {
  try {
    warn(text);
  } catch {
    // The failure being reported IS this warn; there is nowhere left to report it to.
  }
}

/** And a pause that rejects is no reason to skip the waves that remain. */
async function sleepQuietly(sleep: (ms: number) => Promise<void>, ms: number): Promise<void> {
  try {
    await sleep(ms);
  } catch {
    // deliberately empty
  }
}

/**
 * Pushes each selected wave, one at a time, and resolves with how many the
 * service took. Never throws and never rejects, whatever `run`, `sleep` or `warn`
 * do: one wave the service refused must not cost the operator the other four.
 */
export async function pushStatus(
  deps: PushDeps,
  status: WaveStatus,
  options: PushOptions,
): Promise<number> {
  const warn = (text: string): void => quietly(deps.warn, text);
  // A refusal is one fact about the tree, not news that arrives every interval.
  // The caller owns the memory; a dep set without one repeats, as it always did.
  const said = deps.warned ?? new Set<string>();
  const once = (text: string): void => {
    if (said.has(text)) return;
    said.add(text);
    quietly(deps.warn, text);
  };
  const selected = selectWaves(status, options, deps.nowMs(), once);

  // A wave whose every lane was refused is not pushed and not spaced for: there
  // is nothing to send, so there is nothing to wait between.
  const planned: { readonly wave: WaveStatus["waves"][number]; readonly stdin: string }[] = [];
  for (const wave of selected) {
    const body = toPushLanes(wave.lanes, once);
    if (body.lanes.length === 0) {
      once(`waves push: ${wave.id}: no lane the service would accept; nothing pushed`);
      continue;
    }
    planned.push({ wave, stdin: JSON.stringify(body) });
  }

  const interval = intervalFor(options.watch, planned.length);
  if (
    options.watch !== false &&
    spacingSeconds(options.watch, planned.length) > MAX_INTERVAL_SECONDS
  ) {
    warn(
      `waves push: --watch ${options.watch} over ${planned.length} wave(s) reports at most ` +
        `${MAX_INTERVAL_SECONDS}s, so the service will read them stale between pushes`,
    );
  }

  let pushed = 0;
  for (let index = 0; index < planned.length; index++) {
    const { wave, stdin } = planned[index]!;
    // Spacing goes BETWEEN two pushes: not before the first, not after the last.
    if (index > 0) await sleepQuietly(deps.sleep, PUSH_SPACING_MS);
    const args = ["push", "--wave", wave.id, "--stdin"];
    if (interval !== undefined) args.push("--interval", String(interval));
    try {
      const run = await deps.run(args, stdin);
      if (run.code !== 0) warn(refusedLine(wave.id, run.code, run.stderr));
      else pushed += 1;
    } catch (error: unknown) {
      warn(unrunnableLine(wave.id, error instanceof Error ? error.message : String(error)));
    }
  }
  return pushed;
}

/** The env the client is handed: ours, with the project's id filled in when the environment names none. */
function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const project = env.WAVES_PROJECT;
  return {
    ...env,
    WAVES_PROJECT: project === undefined || project === "" ? DEFAULT_WAVES_PROJECT : project,
  };
}

/**
 * The deps the print face pushes with: the installed client by its pinned path, a
 * real pause, a real clock. No token is read, passed or printed here — the client
 * takes it from its own file.
 */
export function realPushDeps(env: NodeJS.ProcessEnv, logError: (text: string) => void): PushDeps {
  return {
    run: (args, stdin) =>
      new Promise<PushRun>((settle, reject) => {
        const options = { env: childEnv(env), timeout: 60_000 };
        const child = execFile(WAVES_BIN, args, options, (error, _stdout, stderr) => {
          if (error === null) {
            settle({ code: 0, stderr });
            return;
          }
          // A non-zero exit is an answer the client means — code 2 carries the
          // reason on stderr. Only a process that could not start at all rejects,
          // including one the timeout killed.
          if (typeof error.code === "number") {
            settle({ code: error.code, stderr });
            return;
          }
          reject(error);
        });
        // The client exits on a usage or configuration refusal without reading
        // stdin, so the write below can hit a closed pipe — and an unhandled
        // `error` on child.stdin is an uncaught exception no try here can see.
        child.stdin?.on("error", () => {});
        child.stdin?.end(stdin);
      }),
    sleep: (ms) => new Promise<void>((done) => setTimeout(done, ms)),
    warn: logError,
    nowMs: () => Date.now(),
    // One set for the life of the process: the same deps object is handed to
    // every tick, so a refusal stays said instead of scrolling past every interval.
    warned: new Set<string>(),
  };
}
