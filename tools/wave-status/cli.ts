import { pathToFileURL } from "node:url";
import { resolveRoot } from "./bin.js";
import { collect, realDeps } from "./lib/collect.js";
import { renderStatus } from "./lib/render.js";
import type { WaveStatus } from "./lib/types.js";

const DEFAULT_WATCH_SECONDS = 10;
const WATCH_FLAG = "--watch";
const WATCH_PREFIX = "--watch=";
const ROOT_FLAG = "--root";
const ROOT_PREFIX = "--root=";

/** The argv contract: `--watch[=SECONDS]` re-collects forever; `--root <path>` moves the log root. */
export interface ParsedArgs {
  /** Seconds between re-collections; false means collect once and exit. */
  readonly watch: number | false;
  readonly root?: string;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let watch: number | false = false;
  let root: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === WATCH_FLAG) {
      watch = DEFAULT_WATCH_SECONDS;
    } else if (arg.startsWith(WATCH_PREFIX)) {
      const seconds = Number(arg.slice(WATCH_PREFIX.length));
      if (!Number.isInteger(seconds) || seconds < 1) {
        throw new Error(`invalid --watch seconds: ${JSON.stringify(arg.slice(WATCH_PREFIX.length))}`);
      }
      watch = seconds;
    } else if (arg === ROOT_FLAG) {
      const next = argv[i + 1];
      if (next === undefined) throw new Error("--root requires a path");
      root = next;
      i += 1;
    } else if (arg.startsWith(ROOT_PREFIX)) {
      root = arg.slice(ROOT_PREFIX.length);
    } else {
      throw new Error(`unknown argument: ${JSON.stringify(arg)}`);
    }
  }
  return { watch, root };
}

/** Everything `runCli` needs from the process, injected so tests never touch a TTY or the clock. */
export interface CliIo {
  readonly argv: readonly string[];
  readonly WAVE_LOG_ROOT?: string;
  readonly isTTY: boolean;
  readonly noColor: boolean;
  readonly log: (text: string) => void;
  readonly collect: (root: string) => Promise<WaveStatus>;
  readonly schedule: (fn: () => void, ms: number) => unknown;
}

/**
 * The print face of `yarn wave:status`: collect once, render once, exit — or,
 * with `--watch`, re-collect on an interval until interrupted. The root
 * resolves exactly as bin.ts does, so the two faces never disagree.
 */
export async function runCli(io: CliIo): Promise<void> {
  const args = parseArgs(io.argv);
  const root = resolveRoot({ root: args.root, WAVE_LOG_ROOT: io.WAVE_LOG_ROOT });
  const color = io.isTTY && !io.noColor;
  const print = async (): Promise<void> => {
    io.log(renderStatus(await io.collect(root), { color }));
  };
  await print();
  if (args.watch !== false) {
    io.schedule(() => void print(), args.watch * 1000);
  }
}

/* istanbul ignore next -- CLI entry guard; runCli() is covered directly in tests */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli({
    argv: process.argv.slice(2),
    WAVE_LOG_ROOT: process.env.WAVE_LOG_ROOT,
    isTTY: process.stdout.isTTY === true,
    noColor: process.env.NO_COLOR !== undefined,
    log: (text) => console.log(text),
    collect: (root) => collect(realDeps, root, new Date().toISOString()),
    schedule: (fn, ms) => setInterval(fn, ms),
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
