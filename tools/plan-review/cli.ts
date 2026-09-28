import { readEvents } from "../wave-status/lib/events.js";
import { asHashRecord, rowHash } from "./lib/rows.js";
import { governingPlanReview } from "./lib/review.js";
import { relative, resolve } from "node:path";
import type { WaveEvent } from "../wave-status/lib/types.js";

/**
 * The plan-review gate's command face. `hashes` fingerprints the rows an
 * orchestrator is about to dispatch against — lane rows and decision rows
 * alike — so the reviewer's report can carry those fingerprints, and `check`
 * re-runs the comparison the gate promises: a lane may be dispatched only when
 * the wave's latest `plan-review settled` event recorded a clear verdict over
 * row fingerprints that still match the plan on disk.
 */

export interface PlanReviewIo {
  readonly argv: readonly string[];
  readonly log: (text: string) => void;
  readonly logError: (text: string) => void;
  readonly readFile: (path: string) => Promise<string>;
}

const USAGE =
  "usage: plan:review hashes <plan.md> <id>…\n" +
  "       plan:review check <plan.md> --logdir <dir> --wave <wave> <laneId>";

/** The message of a thrown value, or its text — never a bare `[object Object]`. */
export function errorText(thrown: unknown): string {
  if (thrown instanceof Error) {
    return thrown.message !== "" ? thrown.message : thrown.name;
  }
  if (typeof thrown === "string") {
    return thrown;
  }
  return String(thrown);
}

/** Decision ids sort under `decisions`; every other id is a lane row. */
function isDecisionId(id: string): boolean {
  return /^D\d+/.test(id);
}

/**
 * The form plan paths are compared in: resolved against the working
 * directory, then made relative to it, so a review recorded as
 * `docs/planning/p.md` and a command line naming the same file absolutely
 * agree, and a sibling file never does.
 */
function normalisePlanPath(plan: string): string {
  return relative(process.cwd(), resolve(plan));
}

export async function runCli(io: PlanReviewIo): Promise<number> {
  const [command, ...rest] = io.argv;
  if (command === "hashes") return hashes(rest, io);
  if (command === "check") return check(rest, io);
  io.logError(USAGE);
  return 2;
}

async function hashes(args: readonly string[], io: PlanReviewIo): Promise<number> {
  const [plan, ...ids] = args;
  if (plan === undefined) {
    io.logError(USAGE);
    return 2;
  }
  const markdown = await io.readFile(plan);
  const rows: Record<string, string> = {};
  const decisions: Record<string, string> = {};
  for (const id of ids) {
    const hash = rowHash(markdown, id);
    if (isDecisionId(id)) decisions[id] = hash;
    else rows[id] = hash;
  }
  io.log(JSON.stringify({ rows, decisions }));
  return 0;
}

interface CheckArgs {
  readonly plan: string;
  readonly laneId: string;
  readonly logdir: string;
  readonly wave: string;
}

function parseCheckArgs(args: readonly string[]): CheckArgs | undefined {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--logdir" || arg === "--wave") {
      const value = args[i + 1];
      if (value === undefined) return undefined;
      flags.set(arg, value);
      i += 1;
    } else if (arg.startsWith("--")) {
      return undefined;
    } else {
      positionals.push(arg);
    }
  }
  const logdir = flags.get("--logdir");
  const wave = flags.get("--wave");
  if (positionals.length !== 2 || logdir === undefined || wave === undefined) return undefined;
  return { plan: positionals[0], laneId: positionals[1], logdir, wave };
}

/** Why `id`'s row no longer matches `reviewed`, or `undefined` when it does. */
function rowDiff(markdown: string, id: string, reviewed: string): string | undefined {
  let current: string;
  try {
    current = rowHash(markdown, id);
  } catch (error: unknown) {
    return `${id} (no unambiguous row: ${errorText(error)})`;
  }
  return current === reviewed ? undefined : id;
}

/**
 * The log as the gate reads it: every event with the line it came from, and
 * every line the reader cannot accept — a rejected line, or the torn tail of
 * a file whose writer died mid-line. One walk through the same reader the
 * whole system parses with, line by line, so the gate's view of "unreadable"
 * is the reader's own, never a second opinion.
 */
function readLog(text: string): {
  readonly events: readonly WaveEvent[];
  readonly lineOf: readonly number[];
  readonly unreadable: readonly number[];
} {
  const physical = text.split("\n");
  if (text.endsWith("\n")) physical.pop(); // the artifact of the trailing newline, not a line
  const events: WaveEvent[] = [];
  const lineOf: number[] = [];
  const unreadable: number[] = [];
  for (let i = 0; i < physical.length; i++) {
    if (physical[i].trim() === "") continue;
    const read = readEvents(physical[i]);
    for (const event of read.events) {
      events.push(event);
      lineOf.push(i);
    }
    if (read.events.length === 0) unreadable.push(i);
  }
  return { events, lineOf, unreadable };
}

async function check(args: readonly string[], io: PlanReviewIo): Promise<number> {
  const parsed = parseCheckArgs(args);
  if (parsed === undefined) {
    io.logError(USAGE);
    return 2;
  }
  const { plan, laneId, logdir, wave } = parsed;
  const logPath = `${logdir}/events.jsonl`;

  let eventsText: string;
  try {
    eventsText = await io.readFile(logPath);
  } catch (error: unknown) {
    io.logError(`could not read ${logPath}: ${errorText(error)}`);
    return 2;
  }

  const log = readLog(eventsText);
  const review = governingPlanReview(log.events, wave);
  if (review === undefined) {
    io.logError(`no plan-review settled event for wave ${wave} in ${logPath}`);
    return 2;
  }

  // Fail closed on an unreadable tail: a line the reader cannot accept that
  // is newer than the chosen review leaves the log's own word unknown — the
  // chosen review may already have been superseded by one that never parsed.
  const tornAfter = log.unreadable.filter((line) => line > log.lineOf[review.index]);
  if (tornAfter.length > 0) {
    io.logError(
      `${logPath} has unreadable line(s) ${tornAfter.map((line) => line + 1).join(", ")} after the latest plan-review event — the log tail cannot be read`,
    );
    return 2;
  }

  // The review governs the plan it was taken against, and nothing else: the
  // latest review of a different plan file is no review for this lane, even
  // when the two plans' rows coincide — the row hashes would match while the
  // verdict was never asked about this file.
  const reviewedPlan = review.plan;
  if (reviewedPlan === undefined) {
    io.logError(
      `the latest plan-review settled event for wave ${wave} names no plan file — no review for this lane`,
    );
    return 2;
  }
  if (normalisePlanPath(reviewedPlan) !== normalisePlanPath(plan)) {
    io.logError(
      `the latest review for wave ${wave} is of ${reviewedPlan}, not ${plan} — no review for this lane`,
    );
    return 2;
  }

  const rows = asHashRecord(review.event.detail?.rows);
  if (rows === undefined) {
    io.logError(`the latest plan-review event for wave ${wave} carries no usable rows map`);
    return 2;
  }
  const reviewed = rows[laneId];
  if (reviewed === undefined) {
    io.logError(`lane ${laneId} is absent from the review's rows for wave ${wave}`);
    return 2;
  }

  const verdict = review.event.detail?.verdict;
  if (typeof verdict !== "string") {
    io.logError(`the review of wave ${wave} carries no verdict`);
    return 2;
  }
  if (verdict === "changes-required") {
    io.logError(`the review of ${plan} for wave ${wave} ended changes-required`);
    return 3;
  }
  if (verdict !== "clear") {
    io.logError(`verdict ${verdict} is neither clear nor changes-required`);
    return 1;
  }

  let markdown: string;
  try {
    markdown = await io.readFile(plan);
  } catch (error: unknown) {
    io.logError(`could not read ${plan}: ${errorText(error)}`);
    return 2;
  }

  const decisionsDetail = review.event.detail?.decisions;
  let decisions: Record<string, string> = {};
  if (decisionsDetail !== undefined) {
    // An absent decisions field is a review that recorded none; a present
    // one that fails to read is a broken record, and a broken record may
    // not be read as "nothing to compare" — the gate fails closed.
    const parsed = asHashRecord(decisionsDetail);
    if (parsed === undefined) {
      io.logError(
        `the latest plan-review event for wave ${wave} carries a malformed decisions map`,
      );
      return 2;
    }
    decisions = parsed;
  }
  const diffs = [
    rowDiff(markdown, laneId, reviewed),
    ...Object.entries(decisions).map(([id, hash]) => rowDiff(markdown, id, hash)),
  ].filter((diff) => diff !== undefined);
  if (diffs.length > 0) {
    io.logError(`plan changed since the review: ${diffs.join("; ")}`);
    return 1;
  }
  return 0;
}

/* The entry guard is covered, not ignored: the entry tests reset the module
   registry and re-import this file with process.argv patched, so both arms of
   each guard run under the suite like every other branch. */
if (process.argv[1]) {
  const { pathToFileURL } = await import("node:url");
  if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const { readFile } = await import("node:fs/promises");
    runCli({
      argv: process.argv.slice(2),
      log: (text) => console.log(text),
      logError: (text) => console.error(text),
      readFile: (path) => readFile(path, "utf8"),
    })
      .then((code) => {
        process.exitCode = code;
      })
      .catch((error: unknown) => {
        console.error(errorText(error));
        process.exitCode = 1;
      });
  }
}
