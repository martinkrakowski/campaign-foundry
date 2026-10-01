import { LANE_WATCH_USAGE } from "./usage-text.js";

/**
 * `lane:watch usage --server <url> --session <id> …` — read the session once
 * and print what it has cost.
 */
export interface UsageArgs {
  readonly command: "usage";
  readonly server: string;
  readonly session: string;
  readonly json: boolean;
  /** Absent unless `--emit` was given; when present, the usage is also logged. */
  readonly emit: EmitArgs | null;
}

/**
 * `lane:watch follow --server <url> --session <id> [--stall <secs>]` — watch
 * the lane's live progress until it goes idle, errors, or goes quiet.
 */
export interface FollowArgs {
  readonly command: "follow";
  readonly server: string;
  readonly session: string;
  readonly stallSecs: number;
}

/**
 * `--emit <logdir> <wave> <lane> <stage> [--event settled|failed]`.
 *
 * The stage, event, wave and lane are NOT validated here. `scripts/wave-event.sh`
 * owns that list, and a second copy in TypeScript is a list that drifts: the
 * script rejects an unknown stage with its own reason on stderr and exit 2, and
 * this tool relays both rather than pre-empting it with a staler message.
 */
export interface EmitArgs {
  readonly logdir: string;
  readonly wave: string;
  readonly lane: string;
  readonly stage: string;
  readonly event: string;
}

/** The stall default the row names: ten minutes of silence for ONE session. */
export const DEFAULT_STALL_SECS = 600;

/** Reads the value that must follow a long option, or fails with the usage line. */
function valueAfter(argv: readonly string[], i: number, flag: string): string {
  const raw = argv[i];
  if (raw === undefined || raw.startsWith("--")) {
    throw new Error(`missing value for ${flag}\n${LANE_WATCH_USAGE}`);
  }
  return raw;
}

/**
 * Parses `lane:watch usage --server <url> --session <id> [--json] [--emit …]`.
 *
 * `--emit` takes its four operands POSITIONALLY (`--emit <logdir> <wave> <lane>
 * <stage>`), which is what the row specifies and what `wave-event.sh` itself
 * takes after `--logdir`. Reordering them here would be a second convention to
 * keep in step with the script's.
 */
export function parseUsageArgs(argv: readonly string[]): UsageArgs {
  let server: string | undefined;
  let session: string | undefined;
  let json = false;
  let emit: EmitArgs | null = null;
  let event: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--server": {
        server = valueAfter(argv, ++i, flag);
        break;
      }
      case "--session": {
        session = valueAfter(argv, ++i, flag);
        break;
      }
      case "--json": {
        json = true;
        break;
      }
      case "--emit": {
        const logdir = valueAfter(argv, ++i, flag);
        const wave = valueAfter(argv, ++i, flag);
        const lane = valueAfter(argv, ++i, flag);
        const stage = valueAfter(argv, ++i, flag);
        emit = { logdir, wave, lane, stage, event: "settled" };
        break;
      }
      case "--event": {
        event = valueAfter(argv, ++i, flag);
        break;
      }
      default:
        throw new Error(`unknown argument '${flag}'\n${LANE_WATCH_USAGE}`);
    }
  }

  if (server === undefined) throw new Error(`a --server is required\n${LANE_WATCH_USAGE}`);
  if (session === undefined) throw new Error(`a --session is required\n${LANE_WATCH_USAGE}`);
  if (event !== undefined) {
    if (emit === null) {
      throw new Error(`--event belongs to --emit\n${LANE_WATCH_USAGE}`);
    }
    emit = { ...emit, event };
  }
  return { command: "usage", server, session, json, emit };
}

/**
 * Parses `lane:watch follow --server <url> --session <id> [--stall <secs>]`.
 *
 * `--stall` is in SECONDS because that is the unit an operator reading a brief
 * thinks in, and the row's default (600) is written that way. It is converted
 * to milliseconds at the one place a timer is armed.
 */
export function parseFollowArgs(argv: readonly string[]): FollowArgs {
  let server: string | undefined;
  let session: string | undefined;
  let stallSecs = DEFAULT_STALL_SECS;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--server": {
        server = valueAfter(argv, ++i, flag);
        break;
      }
      case "--session": {
        session = valueAfter(argv, ++i, flag);
        break;
      }
      case "--stall": {
        const raw = valueAfter(argv, ++i, flag);
        if (!/^\d+$/.test(raw)) {
          throw new Error(
            `--stall wants a whole number of seconds, got '${raw}'\n${LANE_WATCH_USAGE}`,
          );
        }
        stallSecs = Number(raw);
        break;
      }
      default:
        throw new Error(`unknown argument '${flag}'\n${LANE_WATCH_USAGE}`);
    }
  }

  if (server === undefined) throw new Error(`a --server is required\n${LANE_WATCH_USAGE}`);
  if (session === undefined) throw new Error(`a --session is required\n${LANE_WATCH_USAGE}`);
  return { command: "follow", server, session, stallSecs };
}
