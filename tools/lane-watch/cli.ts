import { pathToFileURL } from "node:url";
import { parseFollowArgs, parseUsageArgs, type FollowArgs, type UsageArgs } from "./lib/args.js";
import { emit } from "./lib/emit.js";
import { EXIT_OK, EXIT_USAGE, errorText } from "./lib/errors.js";
import { follow, type FollowIo } from "./lib/follow.js";
import { checkServer, checkSession, makeGet, type FetchLike } from "./lib/server.js";
import type { SpawnResult } from "./lib/types.js";
import { LANE_WATCH_USAGE } from "./lib/usage-text.js";
import { readUsage } from "./lib/usage.js";

/**
 * Everything `runCli` touches outside itself, injected. A test supplies all of
 * it, so no test can reach a real server, a real clock, or a real process.
 */
export interface LaneWatchCliIo {
  readonly argv: readonly string[];
  readonly log: (text: string) => void;
  readonly logError: (text: string) => void;
  readonly fetch: FetchLike;
  readonly spawn: (command: string, args: readonly string[]) => Promise<SpawnResult>;
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
}

/**
 * `lane:watch usage --server <url> --session <id> [--json] [--emit …]`.
 *
 * The AbortController is created here and aborted in a `finally`, so EVERY
 * exit path — read, 404, unparseable, unreported, emitted, or a throw out of
 * the emit — aborts the in-flight request.
 *
 * `--emit` runs only on a COMPLETE reading. Emitting a partial one would put a
 * `settled` event on the wave whose detail reads `tokens: null`, and the
 * status page would then show a lane settled from a reading that said it knew
 * nothing. The read's own exit 3 already said so, and passing it through keeps
 * that the single answer.
 */
async function runUsage(args: UsageArgs, io: LaneWatchCliIo): Promise<number> {
  // Both validations run BEFORE the read. A session id that is not `ses_…` is
  // a command line this tool cannot act on, and it must be exit 2 — not a
  // read that fails, which is exit 1 and reads as "the server said no".
  const server = checkServer(args.server);
  const session = checkSession(args.session);
  const get = makeGet(server, io.fetch);
  const controller = new AbortController();
  try {
    const { code, usage } = await readUsage(
      { ...args, server, session },
      {
        get,
        signal: controller.signal,
        log: io.log,
        logError: io.logError,
      },
    );
    if (args.emit === null || usage === null || code !== EXIT_OK) return code;
    const emitted = await emit(args.emit, usage, {
      spawn: io.spawn,
      log: io.log,
      logError: io.logError,
    });
    return emitted.code;
  } finally {
    controller.abort();
  }
}

/**
 * `lane:watch follow --server <url> --session <id> [--stall <secs>]`.
 *
 * The same abort discipline as `usage`, and it matters more here: a watch that
 * returns while its subscription is still open leaves a socket and a
 * server-side subscription running for a process that has already answered.
 * On a tunnel that is a leak per invocation, and a lane run per lane.
 */
async function runFollow(args: FollowArgs, io: LaneWatchCliIo): Promise<number> {
  const controller = new AbortController();
  const deps: FollowIo = {
    get: makeGet(checkServer(args.server), io.fetch),
    signal: controller.signal,
    log: io.log,
    logError: io.logError,
    setTimer: io.setTimer,
    clearTimer: io.clearTimer,
  };
  try {
    return await follow({ ...args, session: checkSession(args.session) }, deps);
  } finally {
    controller.abort();
  }
}

/**
 * `lane:watch <usage|follow> …`
 *
 * Exit codes are the tool's contract, and `lib/usage-text.ts` states them:
 * 0 the lane went idle or the usage was read; 1 not found, errored, or
 * dropped; 2 the command line is wrong; 3 unreported or stalled, which means
 * investigate. 2 is reserved for a command line this tool cannot act on and
 * nothing else returns it — a server that refuses a read is 1, because the
 * operator typed a valid command and the answer was no.
 */
export async function runCli(io: LaneWatchCliIo): Promise<number> {
  const [command, ...rest] = io.argv;
  try {
    if (command === "usage") return await runUsage(parseUsageArgs(rest), io);
    if (command === "follow") return await runFollow(parseFollowArgs(rest), io);
  } catch (error) {
    io.logError(`lane:watch: ${errorText(error)}`);
    return EXIT_USAGE;
  }
  io.logError(
    command === undefined
      ? `lane:watch: no command.\n${LANE_WATCH_USAGE}`
      : `lane:watch: '${command}' is not a command.\n${LANE_WATCH_USAGE}`,
  );
  return EXIT_USAGE;
}

/* istanbul ignore next -- CLI entry: the thin wrapper over node:child_process
   and Node's global fetch, plus the entry guard. runCli() and every branch it
   feeds are covered directly in tests. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { execFile } = await import("node:child_process");
  runCli({
    argv: process.argv.slice(2),
    log: (text) => console.log(text),
    logError: (text) => console.error(text),
    // The ONLY mention of the global `fetch` in tools/lane-watch/: everything
    // else goes through `get`, which is what makes the method, the redirect
    // mode and the two-path allowlist structural rather than per-caller.
    fetch: (url, init) => fetch(url, init),
    spawn: (command, args) =>
      new Promise<SpawnResult>((resolve) => {
        execFile(command, [...args], (error, _stdout, stderr) => {
          if (error === null) {
            resolve({ code: 0, stderr });
            return;
          }
          // A number is the exit status of a process that ran and failed.
          // Anything else means it never launched, and the 1 below stands for
          // "did not run" — it is not a claim that the script refused.
          const code = (error as NodeJS.ErrnoException & { code?: number | string }).code;
          resolve(typeof code === "number" ? { code, stderr } : { code: 1, stderr });
        });
      }),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(`lane:watch: ${errorText(error)}`);
      process.exitCode = 1;
    });
}
