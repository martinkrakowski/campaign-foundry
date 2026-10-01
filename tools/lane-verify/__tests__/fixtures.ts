import type { Recorded } from "../lib/git.js";
import type { VerifyIo } from "../lib/verify.js";
import type { ProcessRunner, RunResult } from "../lib/types.js";

/**
 * The recording runner every test in this directory drives the tool with.
 *
 * Nothing here spawns anything. A test answers the calls the tool makes by key
 * (`command` plus its argv, joined) and then asserts on the recording, which is
 * what lets a whole run — four refusals, every red step, the restore after a
 * throw — be exercised with no repository, no vitest and no git.
 */

export const WORKTREE = "/wt/lane";
export const BRANCH = "feat/lane";
export const HEAD = "1111111111111111111111111111111111111111";
export const VERIFIED = "2222222222222222222222222222222222222222";
export const LOCK = "the lockfile bytes\n";
export const SUMMARY_AT = `${WORKTREE}/coverage/coverage-summary.json`;
/** The vitest argv `greenScript` answers, as one key. */
export const VITEST_KEY =
  "yarn vitest run --project tools --coverage --coverage.include=tools/lane-verify/**/*.ts --coverage.reporter=json-summary";

export interface Call {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

/**
 * One scripted answer, or several answered IN ORDER under the same key.
 *
 * The array form is for the two calls that share an argv and do not do the same
 * thing: `git rev-parse HEAD` is how the worktree's own commit is recorded before
 * the checkout and how the VERIFIED commit is read back after it. When one value
 * is left it is reused, so a test that only cares about one of them says one.
 */
export type Answer = RunResult | readonly RunResult[];

export interface Recording {
  readonly run: ProcessRunner;
  readonly calls: readonly Call[];
  /** The argv of every recorded call whose command and argv contain `needle`. */
  argvFor(needle: string): readonly (readonly string[])[];
}

const ok = (stdout = "", stderr = ""): RunResult => ({ code: 0, stdout, stderr });
const fail = (code: number, stdout = "", stderr = ""): RunResult => ({ code, stdout, stderr });

export { ok, fail };

/** A linked worktree with no tracked change, and every step green. */
export function greenScript(): Record<string, Answer> {
  return {
    "git rev-parse --git-dir": ok("/repo/.git/worktrees/lane"),
    "git rev-parse --git-common-dir": ok("/repo/.git"),
    "git status --porcelain": ok("?? coverage/\n"),
    "git fetch -q origin feat/lane": ok(),
    "git rev-parse HEAD": [ok(`${HEAD}\n`), ok(`${VERIFIED}\n`)],
    "git symbolic-ref -q --short HEAD": ok(`${BRANCH}\n`),
    [`git show ${HEAD}:yarn.lock`]: ok(LOCK),
    [`git show origin/${BRANCH}:yarn.lock`]: ok(LOCK),
    [`git checkout -q --detach origin/${BRANCH}`]: ok(),
    [`git checkout -q ${BRANCH}`]: ok(),
    [VITEST_KEY]: ok(" Test Files  1 passed (1)\n"),
    "yarn typecheck": ok(),
    "yarn format:check": ok("All matched files use Prettier code style!\n"),
  };
}

/**
 * Builds a runner over a script. A call with no scripted answer REJECTS with the
 * call in the message, so a test that forgets an answer fails as an unhandled
 * call rather than as a mysterious missing row.
 *
 * A key ending in `*` matches by PREFIX, which is what makes the emit
 * answerable: its `--detail` is the finished table, so a test cannot know the
 * argv before the run has produced it. Everything before the `*` — the script,
 * the wave, the lane, the stage and the outcome — is still matched exactly.
 */
export function runnerFor(
  script: Record<string, Answer>,
  handlers: { readonly onCall?: (call: Call) => void } = {},
): Recording {
  const queues = new Map<string, Answer[]>();
  for (const [key, answer] of Object.entries(script)) {
    queues.set(key, Array.isArray(answer) ? [...answer] : [answer]);
  }
  const calls: Call[] = [];
  const run: ProcessRunner = (command, args, options) => {
    const key = `${command} ${args.join(" ")}`;
    const call: Call = { command, args: [...args], cwd: options.cwd };
    calls.push(call);
    handlers.onCall?.(call);
    const match = [...queues.keys()].find((candidate) =>
      candidate.endsWith("*") ? key.startsWith(candidate.slice(0, -1)) : candidate === key,
    );
    const queue = match === undefined ? undefined : queues.get(match);
    if (queue === undefined || queue.length === 0) {
      return Promise.reject(new Error(`no scripted answer for '${key}'`));
    }
    const answer = queue.length === 1 ? queue[0] : (queue.shift() as RunResult);
    return Promise.resolve(answer as RunResult);
  };
  return {
    run,
    calls,
    argvFor: (needle) =>
      calls.filter((c) => `${c.command} ${c.args.join(" ")}`.includes(needle)).map((c) => c.args),
  };
}

const BUCKET_FULL = { total: 4, covered: 4, skipped: 0, pct: 100 };

export type MetricName = "lines" | "branches" | "functions" | "statements";

/** A summary entry that is at 100 in every metric unless `short` names one. */
export function entry(short: Partial<Record<MetricName, number>> = {}): Record<string, unknown> {
  return Object.fromEntries(
    (["lines", "branches", "functions", "statements"] as const).map((metric) => [
      metric,
      { total: 4, covered: 4, skipped: 0, pct: short[metric] ?? 100 },
    ]),
  );
}

/** A whole `coverage-summary.json`: the named files plus a `total` at 100. */
export function summary(files: Record<string, unknown>): string {
  return JSON.stringify({ ...files, total: entry() });
}

/**
 * A summary carrying nothing but the `total` aggregate — what vitest writes when
 * the `--cover` globs match no file at all. To every other question this tool
 * asks of a summary it looks identical to a perfect run, which is why
 * `measuredAnything` exists.
 */
export const EMPTY_SUMMARY = JSON.stringify({ total: entry() });

/** The non-file dependencies of a run, with recorders for what they were told. */
export interface LaneHarness {
  readonly io: VerifyIo;
  readonly calls: readonly Call[];
  /**
   * Every call and every unlink in the order they happened, as one list — which
   * is the only way to assert about ORDER between a file operation and a command,
   * since neither list alone knows about the other.
   */
  readonly events: readonly string[];
  /** Every publication to `onRecord`, in order: what a signal path would restore. */
  readonly recorded: readonly Recorded[];
  /** Every path `removeFile` was asked to delete. */
  readonly removed: readonly string[];
}

/**
 * A `VerifyIo` over a script, with the two seams a run now has beyond the
 * runner wired to something a test can read: what was deleted, and what was
 * recorded. The latch starts open, exactly as the CLI entry's does.
 */
export function laneIo(
  script: Record<string, Answer> = greenScript(),
  readFile: VerifyIo["readFile"] = async () => summary({ "a.ts": entry() }),
  removeFile: VerifyIo["removeFile"] = async () => undefined,
  handlers: { readonly onCall?: (call: Call) => void } = {},
): LaneHarness {
  const events: string[] = [];
  const { run, calls } = runnerFor(script, {
    onCall: (call) => {
      events.push(`call: ${call.command} ${call.args.join(" ")}`);
      handlers.onCall?.(call);
    },
  });
  const recorded: Recorded[] = [];
  const removed: string[] = [];
  return {
    calls,
    events,
    recorded,
    removed,
    io: {
      run,
      readFile,
      removeFile: async (path) => {
        removed.push(path);
        events.push(`unlink: ${path}`);
        return removeFile(path);
      },
      latch: { restored: false },
      onRecord: (value, _cwd) => {
        recorded.push(value);
      },
    },
  };
}
