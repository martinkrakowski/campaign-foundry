import { isAbsolute } from "node:path";

/**
 * `yarn lane:verify` — the second-host check on a lane branch, run by hand
 * every wave.
 *
 * Every field below is something the run acts on, and the parser's only job is
 * to refuse a command line this tool cannot act on BEFORE any git call: an argv
 * mistake is exit 2 and costs no checkout, no fetch and no test run, and one
 * discovered half way through has already moved the operator's worktree.
 */

/** Where `--emit` sends the one gate event this run may write. */
export interface EmitTarget {
  readonly wave: string;
  readonly lane: string;
}

export interface LaneVerifyArgs {
  /** Absolute, and refused if it is not: every git and vitest call is run there. */
  readonly worktree: string;
  readonly branch: string;
  readonly project: string;
  /** At least one. Each becomes its own `--coverage.include=<glob>`. */
  readonly cover: readonly string[];
  /** Zero or more, appended after the coverage flags. */
  readonly test: readonly string[];
  readonly emit: EmitTarget | null;
  /** Passed to `wave-event.sh` only when given here; omitted otherwise. */
  readonly logdir: string | null;
}

export const LANE_VERIFY_USAGE =
  "usage: lane:verify --worktree <abs path> --branch <name> --project <p> --cover <glob> " +
  "[--cover <glob>…] [--test <path>…] [--emit <wave> <lane>] [--logdir <dir>]";

/**
 * The token class `wave-event.sh` holds a wave and a lane to
 * (`token_re='^[A-Za-z0-9_-]+$'`, checked before it writes anything). Copied
 * rather than delegated because the check has to happen BEFORE the checkout:
 * a wave id the script will refuse is a command-line mistake, and finding that
 * out after the tests have run is 90 seconds and a restored HEAD later.
 */
const TOKEN = /^[A-Za-z0-9_-]+$/;

/**
 * What may NOT appear in a value that is written into an argv, into a log line
 * or into the emitted detail. Every value here reaches a `yarn`/`git` argv as one
 * element, so it cannot inject an argument — but it CAN reach stderr, the
 * coverage table and the wave log verbatim, where a line break writes a second
 * line of somebody else's log.
 */
const NOT_ONE_LINE = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/** Reads the value that must follow a long option, or fails with the usage line. */
function valueAfter(argv: readonly string[], i: number, flag: string): string {
  const raw = argv[i];
  if (raw === undefined || raw.startsWith("--")) {
    throw new Error(`missing value for ${flag}\n${LANE_VERIFY_USAGE}`);
  }
  if (raw.trim() === "") {
    throw new Error(`${flag} was given an empty value\n${LANE_VERIFY_USAGE}`);
  }
  return raw;
}

/**
 * Reads a value that is written verbatim somewhere a reader will see it, and
 * refuses one that would write a line of its own. See {@link NOT_ONE_LINE}.
 */
function lineAfter(argv: readonly string[], i: number, flag: string): string {
  const raw = valueAfter(argv, i, flag);
  if (NOT_ONE_LINE.test(raw)) {
    throw new Error(`${flag} must be a single line\n${LANE_VERIFY_USAGE}`);
  }
  return raw;
}

/**
 * Parses `lane:verify --worktree <abs> --branch <b> --project <p> --cover <glob>…
 * [--test <path>…] [--emit <wave> <lane>] [--logdir <dir>]`.
 *
 * The checks that are not simply "the flag is there":
 *
 * - **`--worktree` must be ABSOLUTE.** Every git and vitest call this tool makes
 *   names it as a `cwd`, and a relative `cwd` is resolved against whatever
 *   directory the operator happened to be standing in. That is the difference
 *   between checking out a lane branch and checking out something else
 *   entirely, discovered by the operator afterwards rather than by this tool.
 * - **`--cover` and `--test` are repeatable; every other flag is not.** Two
 *   `--worktree` values mean a caller whose script appended to a command line
 *   rather than composing it, and taking the last would hide that. One class of
 *   several files is exactly what a repeatable flag is for, which is why these
 *   two are the repeatable ones.
 * - **A repeated `--cover` is refused** once it happens, because a glob listed
 *   twice makes the coverage table name a file twice for one measurement. The
 *   run would still be right; the report would just read as a mistake.
 * - **`--emit` takes its two operands positionally** and both must match the
 *   script's own token class.
 */
export function parseLaneVerifyArgs(argv: readonly string[]): LaneVerifyArgs {
  const seen = new Set<string>();
  const once = (flag: string): void => {
    if (seen.has(flag)) {
      throw new Error(
        `${flag} is given twice, and each flag states one value\n${LANE_VERIFY_USAGE}`,
      );
    }
    seen.add(flag);
  };

  let worktree: string | undefined;
  let branch: string | undefined;
  let project: string | undefined;
  const cover: string[] = [];
  const test: string[] = [];
  let emit: EmitTarget | null = null;
  let logdir: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--worktree":
        once(flag);
        worktree = lineAfter(argv, ++i, flag);
        break;
      case "--branch":
        once(flag);
        branch = lineAfter(argv, ++i, flag);
        break;
      case "--project":
        once(flag);
        project = lineAfter(argv, ++i, flag);
        break;
      case "--cover":
        cover.push(lineAfter(argv, ++i, flag));
        break;
      case "--test":
        test.push(lineAfter(argv, ++i, flag));
        break;
      case "--logdir":
        once(flag);
        logdir = lineAfter(argv, ++i, flag);
        break;
      case "--emit": {
        once(flag);
        const wave = lineAfter(argv, ++i, flag);
        const lane = lineAfter(argv, ++i, flag);
        for (const [name, token] of [
          ["wave", wave],
          ["lane", lane],
        ] as const) {
          if (!TOKEN.test(token)) {
            throw new Error(
              `--emit ${name} '${token}' must match ${TOKEN.source}, the class wave-event.sh holds a wave and a lane to\n${LANE_VERIFY_USAGE}`,
            );
          }
        }
        emit = { wave, lane };
        break;
      }
      default:
        throw new Error(`unknown argument '${String(flag)}'\n${LANE_VERIFY_USAGE}`);
    }
  }

  if (worktree === undefined) throw new Error(`a --worktree is required\n${LANE_VERIFY_USAGE}`);
  if (!isAbsolute(worktree)) {
    throw new Error(
      `--worktree must be an absolute path: every git and test call is run there, and a relative one is resolved against the wrong directory\n${LANE_VERIFY_USAGE}`,
    );
  }
  if (branch === undefined) throw new Error(`a --branch is required\n${LANE_VERIFY_USAGE}`);
  if (project === undefined) throw new Error(`a --project is required\n${LANE_VERIFY_USAGE}`);
  if (cover.length === 0) throw new Error(`at least one --cover is required\n${LANE_VERIFY_USAGE}`);
  const seenGlob = new Set<string>();
  for (const glob of cover) {
    if (seenGlob.has(glob)) {
      throw new Error(
        `--cover ${glob} is listed twice: one file named twice reads as two findings\n${LANE_VERIFY_USAGE}`,
      );
    }
    seenGlob.add(glob);
  }
  return { worktree, branch, project, cover, test, emit, logdir };
}
