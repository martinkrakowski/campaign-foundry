import { fileURLToPath } from "node:url";
import { errorText } from "./errors.js";
import type { EmitTarget } from "./args.js";
import type { ProcessRunner, RunResult } from "./types.js";

/**
 * The one event `--emit` writes, and the two paths it resolves out of this
 * module's own URL rather than out of the working directory.
 *
 * Both are constants computed at import time and that is the entire point. This
 * tool is run from inside a lane's worktree — that is what `--worktree` names —
 * so a path resolved against `process.cwd()` would put `wave-event.sh` at
 * `<lane worktree>/scripts/wave-event.sh` and the gate event for lane HXF11 into
 * whatever log directory that worktree's cwd implies, or into none. The
 * lane's branch is the thing being verified and it must never be the thing that
 * receives the record of its own verification. `import.meta.url` is the only
 * anchor that travels with this code.
 */
export const WAVE_EVENT_SCRIPT = fileURLToPath(
  new URL("../../../scripts/wave-event.sh", import.meta.url),
);

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** `settled` when every step passed and every covered file was at 100. */
export type EmitOutcome = "settled" | "failed";

export interface EmitIo {
  readonly run: ProcessRunner;
  readonly logError: (text: string) => void;
}

/**
 * The argv, in the order the row specifies:
 *
 *   sh <repo>/scripts/wave-event.sh [--logdir <dir>] <wave> <lane> gate \
 *      <settled|failed> --detail <JSON.stringify(detail)>
 *
 * **`--logdir` is passed only when `lane:verify` was given one.** Omitted, the
 * script resolves the log directory itself, which is what `merge-prs.sh`
 * (`:48–57`) deliberately does for `pre-pr-check` rather than passing its own
 * `LOGDIR_OVERRIDE` through when it has none: this tool must not invent a default
 * directory of its own to drift from the one every other writer resolves.
 *
 * The detail is compact — `JSON.stringify` with no spacing — because
 * `wave-event.sh` validates it with a `json.loads` and an `isinstance(…, dict)`,
 * and a spaced object is still an object but a shell-quoted one is not worth
 * finding out about.
 */
export function emitArgv(
  target: EmitTarget,
  logdir: string | null,
  outcome: EmitOutcome,
  detail: unknown,
): readonly string[] {
  return [
    ...(logdir === null ? [] : ["--logdir", logdir]),
    target.wave,
    target.lane,
    "gate",
    outcome,
    "--detail",
    JSON.stringify(detail),
  ];
}

/**
 * Appends the one gate event, and returns the SCRIPT's exit code.
 *
 * The wave, the lane, the stage and the detail are validated by the script, and
 * its exit code and stderr are what this relays. The argv parser already holds
 * wave and lane to the script's token class, but the stage list is not copied
 * here: a second copy of it is a second thing to keep in step with the script's
 * own, and the copy that drifts is the one an operator reads.
 */
export async function emit(
  target: EmitTarget,
  logdir: string | null,
  outcome: EmitOutcome,
  detail: unknown,
  io: EmitIo,
): Promise<number> {
  let result: RunResult;
  try {
    result = await io.run("sh", [WAVE_EVENT_SCRIPT, ...emitArgv(target, logdir, outcome, detail)], {
      cwd: REPO_ROOT,
    });
  } catch (error) {
    io.logError(`lane:verify: wave-event.sh could not be run: ${errorText(error)}`);
    return 1;
  }
  // The script puts its REASON for refusing an event on stderr, so this is the
  // only place that reason can reach the operator.
  if (result.stderr.trim() !== "") io.logError(`wave-event.sh: ${result.stderr.trim()}`);
  return result.code;
}
