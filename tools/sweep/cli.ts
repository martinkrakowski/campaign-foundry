import { pathToFileURL } from "node:url";
import {
  ATTRIBUTE_USAGE,
  GATE_USAGE,
  SWEEP_USAGE,
  parseAttributeArgs,
  parseGateArgs,
  parseSweepArgs,
  type AttributeArgs,
} from "./lib/args.js";
import { attribute } from "./lib/attribute.js";
import { mergeGate, type MergeGatePlan } from "./lib/gate.js";
import { sweep, errorText, type SweepPlan } from "./lib/sweep.js";
import { SweepRefusal } from "./lib/types.js";

export const SWEEP_COMMAND = "threads";
export const GATE_COMMAND = "gate";
export const ATTRIBUTE_COMMAND = "attribute";

/**
 * `gh` colorizes JSON when `FORCE_COLOR` is set, even if stdout is not a
 * TTY — `JSON.parse` then dies on the ANSI prefix, which is how a working
 * GraphQL reply looks like a failed fetch. Drop the color force so the
 * child writes the bytes the parsers already test.
 */
export function ghChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next["FORCE_COLOR"];
  delete next["CLICOLOR_FORCE"];
  return next;
}

export interface SweepCliIo {
  readonly argv: readonly string[];
  readonly log: (text: string) => void;
  readonly logError: (text: string) => void;
  readonly readFile: (path: string) => Promise<string>;
  readonly gh: (args: readonly string[]) => Promise<string>;
}

/**
 * `sweep gate --pr <n> --sha <sha>`
 *
 * Exit codes: 0 every merge condition was decided in favour of the merge;
 * 1 a condition is unmet (an unresolved thread, a head that moved) or could
 * not be decided — a refusal, with every reason listed; 2 the command line
 * itself is wrong.
 *
 * 1 never merges anything: the caller owns `gh pr merge`, and this is the last
 * thing it asks before running it.
 */
async function runGate(rest: readonly string[], io: SweepCliIo): Promise<number> {
  let plan: MergeGatePlan;
  try {
    plan = parseGateArgs(rest);
  } catch (error) {
    io.logError(errorText(error));
    return 2;
  }
  const decision = await mergeGate(plan, { gh: io.gh });
  if (decision.kind === "refuse") {
    io.logError(
      `refusing to merge PR #${plan.pr} — ${decision.reasons.length} reason(s), nothing was merged:`,
    );
    for (const reason of decision.reasons) io.logError(`  ${reason}`);
    return 1;
  }
  io.log(`PR #${plan.pr}: merge condition met — ${decision.summary}`);
  return 0;
}

/**
 * `sweep attribute --pr <n>`
 *
 * Exit codes: 0 every github-actions thread was printed (attributed or
 * unattributed); 1 the threads or a job log could not be read — nothing was
 * guessed; 2 the command line itself is wrong.
 */
async function runAttribute(rest: readonly string[], io: SweepCliIo): Promise<number> {
  let plan: AttributeArgs;
  try {
    plan = parseAttributeArgs(rest);
  } catch (error) {
    io.logError(errorText(error));
    return 2;
  }
  const decision = await attribute(plan, { gh: io.gh });
  if (decision.kind === "fail") {
    for (const reason of decision.reasons) io.logError(reason);
    return 1;
  }
  for (const line of decision.lines) io.log(line);
  return 0;
}

/**
 * `sweep threads --pr … --thread … (--body … | --body-file …) [--post]`
 *
 * Exit codes: 0 the class was disposed (or previewed); 1 the sweep refused
 * (ids not verbatim open threads on the PR) or failed; 2 the command line
 * itself is wrong. A refusal exits 1 with every offending id listed — it is
 * a finding about the ids, not a crash.
 *
 * `sweep gate` is the other verb: the merge condition, answered from the same
 * threads query.
 */
export async function runCli(io: SweepCliIo): Promise<number> {
  const [command, ...rest] = io.argv;
  if (command === GATE_COMMAND) {
    return runGate(rest, io);
  }
  if (command === ATTRIBUTE_COMMAND) {
    return runAttribute(rest, io);
  }
  if (command !== SWEEP_COMMAND) {
    io.logError(`sweep: '${String(command)}' is not a command.`);
    io.logError(SWEEP_USAGE);
    io.logError(GATE_USAGE);
    io.logError(ATTRIBUTE_USAGE);
    return 2;
  }
  let plan: SweepPlan;
  let post: boolean;
  try {
    const args = parseSweepArgs(rest);
    const disposition =
      "text" in args.body ? args.body.text : await io.readFile(args.body.file);
    if (disposition.trim() === "") {
      throw new Error(`a disposition body must not be blank\n${SWEEP_USAGE}`);
    }
    plan = { pr: args.pr, requested: args.threadIds, disposition };
    post = args.post;
  } catch (error) {
    io.logError(error instanceof Error ? error.message : String(error));
    return 2;
  }
  try {
    const result = await sweep(plan, post, { gh: io.gh, out: io.log });
    if (!post) return 0;
    if (result.commentUrl === null) {
      io.logError(
        "the comment did not report a url; re-check the PR before trusting the resolves.",
      );
      return 1;
    }
    const unresolved = plan.requested.filter((id) => !result.resolvedThreadIds.includes(id));
    if (unresolved.length > 0) {
      io.logError(
        `these ids did not come back resolved: ${unresolved.join(", ")} — re-read the PR, do not retry blindly.`,
      );
      return 1;
    }
    io.log(`class disposed: ${result.commentUrl}`);
    return 0;
  } catch (error) {
    if (error instanceof SweepRefusal) {
      io.logError(error.message);
      for (const reason of error.reasons) io.logError(`  ${reason}`);
      return 1;
    }
    io.logError(errorText(error));
    return 1;
  }
}

/* istanbul ignore next -- CLI entry: the thin wrapper over gh and node:fs,
   plus the entry guard. runCli() and every branch it feeds are covered
   directly in tests. */
if (process.argv[1]) {
  const { execFile } = await import("node:child_process");
  const { readFile } = await import("node:fs/promises");
  if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    runCli({
      argv: process.argv.slice(2),
      log: (text) => console.log(text),
      logError: (text) => console.error(text),
      readFile: (path) => readFile(path, "utf8"),
      gh: (args) =>
        new Promise((resolve, reject) => {
          execFile("gh", [...args], { maxBuffer: 16 * 1024 * 1024, env: ghChildEnv(process.env) }, (error, stdout, stderr) => {
            if (error !== null) {
              reject(new Error(`gh ${args.slice(0, 2).join(" ")}: ${stderr.trim() || error.message}`));
            } else {
              resolve(stdout);
            }
          });
        }),
    })
      .then((code) => {
        process.exitCode = code;
      })
      .catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}
