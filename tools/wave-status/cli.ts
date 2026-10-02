import { pathToFileURL } from "node:url";
import { resolveRoot } from "./bin.js";
import { collect, realDeps } from "./lib/collect.js";
import { pushStatus, realPushDeps, WAVE_ID_PATTERN, type PushOptions } from "./lib/push.js";
import { renderStatus } from "./lib/render.js";
import type { WaveStatus } from "./lib/types.js";

const DEFAULT_WATCH_SECONDS = 10;
const WATCH_FLAG = "--watch";
const WATCH_PREFIX = "--watch=";
const ROOT_FLAG = "--root";
const ROOT_PREFIX = "--root=";
const PUSH_FLAG = "--push";
const WAVE_FLAG = "--wave";
const WAVE_PREFIX = "--wave=";
const WAVES_URL_UNSET = "wave:status --push: WAVES_URL is not set; nothing pushed";

/**
 * The argv contract: `--watch[=SECONDS]` re-collects forever; `--root <path>`
 * moves the log root; `--push` sends each wave's status to the waves service,
 * optionally narrowed to the ids `--wave` names.
 */
export interface ParsedArgs {
  /** Seconds between re-collections; false means collect once and exit. */
  readonly watch: number | false;
  readonly root?: string;
  readonly push: boolean;
  /** Wave ids named with `--wave`; empty means "the recent ones". */
  readonly waves: readonly string[];
}

/** The service's own id rule: anything else is a value it would refuse, so nothing starts. */
function waveId(value: string): string {
  if (!WAVE_ID_PATTERN.test(value)) {
    throw new Error(`invalid --wave id: ${JSON.stringify(value)}`);
  }
  return value;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let watch: number | false = false;
  let root: string | undefined;
  let push = false;
  const waves: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === WATCH_FLAG) {
      watch = DEFAULT_WATCH_SECONDS;
    } else if (arg.startsWith(WATCH_PREFIX)) {
      const seconds = Number(arg.slice(WATCH_PREFIX.length));
      if (!Number.isInteger(seconds) || seconds < 1) {
        throw new Error(
          `invalid --watch seconds: ${JSON.stringify(arg.slice(WATCH_PREFIX.length))}`,
        );
      }
      watch = seconds;
    } else if (arg === ROOT_FLAG) {
      const next = argv[i + 1];
      if (next === undefined) throw new Error("--root requires a path");
      if (next === "" || next.startsWith("-"))
        throw new Error(`--root requires a path, not ${JSON.stringify(next)}`);
      root = next;
      i += 1;
    } else if (arg.startsWith(ROOT_PREFIX)) {
      const value = arg.slice(ROOT_PREFIX.length);
      if (value === "" || value.startsWith("-"))
        throw new Error(`--root requires a path, not ${JSON.stringify(value)}`);
      root = value;
    } else if (arg === PUSH_FLAG) {
      push = true;
    } else if (arg === WAVE_FLAG) {
      const next = argv[i + 1];
      if (next === undefined) throw new Error("--wave requires an id");
      waves.push(waveId(next));
      i += 1;
    } else if (arg.startsWith(WAVE_PREFIX)) {
      waves.push(waveId(arg.slice(WAVE_PREFIX.length)));
    } else {
      throw new Error(`unknown argument: ${JSON.stringify(arg)}`);
    }
  }
  if (waves.length > 0 && !push) {
    throw new Error("--wave requires --push");
  }
  return { watch, root, push, waves };
}

/** Everything `runCli` needs from the process, injected so tests never touch a TTY or the clock. */
export interface CliIo {
  readonly argv: readonly string[];
  readonly WAVE_LOG_ROOT?: string;
  /** Where the waves service is. Unset or empty means `--push` pushes nothing at all. */
  readonly WAVES_URL?: string;
  readonly isTTY: boolean;
  readonly noColor: boolean;
  readonly log: (text: string) => void;
  readonly logError: (text: string) => void;
  readonly collect: (root: string) => Promise<WaveStatus>;
  readonly push: (status: WaveStatus, options: PushOptions) => Promise<number>;
  readonly schedule: (fn: () => void, ms: number) => unknown;
  /** The wall clock, injected so a test can state how long a cycle took. */
  readonly nowMs: () => number;
}

/**
 * The print face of `yarn wave:status`: collect once, render once, exit — or,
 * with `--watch`, re-collect on an interval until interrupted. With `--push` the
 * status it just printed is also the status it sends, and a push that fails warns
 * (D197) without failing the run or stopping the loop. The root resolves exactly
 * as bin.ts does, so the two faces never disagree.
 */
export async function runCli(io: CliIo): Promise<void> {
  const args = parseArgs(io.argv);
  const root = resolveRoot({ root: args.root, WAVE_LOG_ROOT: io.WAVE_LOG_ROOT });
  const color = io.isTTY && !io.noColor;
  // Said once for the whole run, not once per tick: a watch that pushed nothing
  // would otherwise print the same line every interval for hours.
  const mayPush = args.push && io.WAVES_URL !== undefined && io.WAVES_URL !== "";
  if (args.push && !mayPush) io.logError(WAVES_URL_UNSET);
  // When the last push started. The gap between two of these is the real cycle —
  // the interval, the collection and every client run — and the service marks a
  // wave stale after three reported intervals, so it is told the truth.
  let cycleStart: number | undefined;
  const print = async (): Promise<void> => {
    // ONE collection per tick: what is rendered and what is pushed are the same status.
    const status = await io.collect(root);
    io.log(renderStatus(status, { color }));
    if (!mayPush) return;
    const startedAt = io.nowMs();
    const lastCycleMs = cycleStart === undefined ? undefined : startedAt - cycleStart;
    cycleStart = startedAt;
    try {
      await io.push(status, { waves: args.waves, watch: args.watch, lastCycleMs });
    } catch (error: unknown) {
      io.logError(error instanceof Error ? error.message : String(error));
    }
  };
  await print();
  if (args.watch !== false) {
    // A self-scheduling loop: each refresh is awaited before the next is armed,
    // so a slow collection delays the interval instead of racing a new print.
    const tick = async (): Promise<void> => {
      await new Promise<void>((resolve) =>
        io.schedule(() => resolve(), (args.watch as number) * 1000),
      );
      try {
        await print();
      } catch (error: unknown) {
        io.logError(error instanceof Error ? error.message : String(error));
      }
      void tick();
    };
    void tick();
  }
}

/* istanbul ignore next -- process entry: the real env, the real console and the real client. runCli() is covered directly in tests. */
export function runFromProcess(argv: readonly string[]): void {
  const deps = realPushDeps(process.env, (text) => console.error(text));
  runCli({
    argv,
    WAVE_LOG_ROOT: process.env.WAVE_LOG_ROOT,
    WAVES_URL: process.env.WAVES_URL,
    isTTY: process.stdout.isTTY === true,
    noColor: process.env.NO_COLOR !== undefined,
    log: (text) => console.log(text),
    logError: (text) => console.error(text),
    collect: (root) => collect(realDeps, root, new Date().toISOString()),
    push: (status, options) => pushStatus(deps, status, options),
    schedule: (fn, ms) => setTimeout(fn, ms),
    nowMs: () => Date.now(),
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

/* istanbul ignore next -- CLI entry guard; runFromProcess() is covered by construction above */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFromProcess(process.argv.slice(2));
}
