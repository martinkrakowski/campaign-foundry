import { fileURLToPath } from "node:url";
import { EXIT_OK, errorText } from "./errors.js";
import type { EmitArgs } from "./args.js";
import type { SpawnResult, Usage } from "./types.js";

/** `emit`'s dependencies. The spawn is injected, so no test runs the script. */
export interface EmitIo {
  readonly spawn: (command: string, args: readonly string[]) => Promise<SpawnResult>;
  readonly log: (text: string) => void;
  readonly logError: (text: string) => void;
}

/**
 * `scripts/wave-event.sh`, resolved from THIS MODULE's own URL — never from
 * `process.cwd()`.
 *
 * That is the whole reason this is a constant computed at import time. A
 * `lane:watch` invoked from inside a lane's worktree, or from `tools/`, or
 * from anywhere else at all, must emit into THIS repo's wave log. A
 * cwd-relative path would resolve against whatever directory the operator
 * happened to be standing in, and the event would land in the wrong wave's log
 * — or in none. `import.meta.url` is the only anchor that travels with the
 * code.
 */
export const WAVE_EVENT_SCRIPT = fileURLToPath(
  new URL("../../../scripts/wave-event.sh", import.meta.url),
);

/**
 * The argv, in the order the row specifies:
 *
 *   sh <repo>/scripts/wave-event.sh --logdir <logdir> <wave> <lane> <stage> \
 *      <event> --detail <JSON.stringify(usage)>
 *
 * The detail is `JSON.stringify` of the usage record with no spacing, because
 * `wave-event.sh` requires a compact JSON object and exits 2 on a spaced one.
 * It is the same record `usage --json` prints, so an emitted event and a
 * printed line cannot disagree.
 */
export function emitArgv(args: EmitArgs, usage: Usage): readonly string[] {
  return [
    "--logdir",
    args.logdir,
    args.wave,
    args.lane,
    args.stage,
    args.event,
    "--detail",
    JSON.stringify(usage),
  ];
}

/**
 * Appends the usage to the wave log by delegating to `wave-event.sh`.
 *
 * The stage, event, wave and lane are validated by the SCRIPT, and its exit
 * code and stderr are what this returns and relays. Duplicating the stage list
 * here would be a second copy to keep in step with the script's own — and the
 * copy that drifts is the one the operator reads. An unknown stage therefore
 * exits 2 with the script's own reason, which is both correct and the reason
 * the list is not repeated in TypeScript.
 */
export async function emit(
  args: EmitArgs,
  usage: Usage,
  io: EmitIo,
): Promise<{ readonly code: number }> {
  let result: SpawnResult;
  try {
    result = await io.spawn("sh", [WAVE_EVENT_SCRIPT, ...emitArgv(args, usage)]);
  } catch (error) {
    io.logError(`lane:watch: wave-event.sh could not be run: ${errorText(error)}`);
    return { code: 1 };
  }
  if (result.stderr.trim() !== "") io.logError(`wave-event.sh: ${result.stderr.trim()}`);
  if (result.code === 0) {
    // DIAGNOSTIC, so it goes to stderr and always does. `usage --json` is a
    // data channel: stdout carries the record and nothing else, so a consumer
    // can parse it as one JSON value. A confirmation line on stdout would make
    // `lane:watch usage --json --emit … | jq` fail on a successful run, which
    // is the one case where nobody expects a parse error.
    io.logError(`emitted ${args.event} for ${args.lane} at ${args.stage}`);
    return { code: EXIT_OK };
  }
  return { code: result.code };
}
