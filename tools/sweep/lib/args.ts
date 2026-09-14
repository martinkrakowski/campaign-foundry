/** `sweep gate --pr <n> --sha <sha>`: the PR, and the head its checks were read on. */
export interface GateArgs {
  readonly pr: number;
  readonly head: string;
}

export interface SweepArgs {
  readonly pr: number;
  readonly threadIds: readonly string[];
  /** `--body`'s text, or the file path from `--body-file` — resolved by the caller. */
  readonly body: { readonly text: string } | { readonly file: string };
  readonly post: boolean;
}

/**
 * Parses `sweep threads --pr <n> --thread <id>... (--body <text> |
 * --body-file <path>) [--post]`.
 *
 * Thread ids are verbatim GraphQL node ids (`PRRT_…`), repeated once per
 * thread of the class. The short `PRVT_…` form that appears in review
 * emails and the web UI names the *discussion*, not the thread node —
 * `resolveReviewThread` rejects it — and ids are kept opaque here because
 * the only reliable check is against the PR's real thread list, which
 * `sweep.ts` runs before anything is written.
 *
 * `--body-file` exists because a disposition is prose with backticks and
 * em-dashes; quoting that through a shell is how a reply gets mangled
 * between the terminal and the timeline.
 *
 * Throws with the usage line for anything the tool cannot act on: a
 * missing `--pr`, a non-numeric `--pr`, an option starved of its value, no
 * `--thread` at all, both body sources or neither, an unknown argument.
 */
export const SWEEP_USAGE =
  "usage: sweep threads --pr <number> --thread <PRRT_id> [--thread …] " +
  "(--body <text> | --body-file <path>) [--post]";

/** Reads the value that must follow a long option, or fails with the caller's usage. */
function valueAfter(argv: readonly string[], i: number, flag: string, usage: string): string {
  const raw = argv[i];
  if (raw === undefined || raw.startsWith("--")) {
    throw new Error(`missing value for ${flag}\n${usage}`);
  }
  return raw;
}

/** Reads a whole number after a long option, or fails with the caller's usage line. */
function numberAfter(argv: readonly string[], i: number, flag: string, usage: string): number {
  const raw = valueAfter(argv, i, flag, usage);
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${flag} wants a number, got '${raw}'\n${usage}`);
  }
  return Number(raw);
}

export function parseSweepArgs(argv: readonly string[]): SweepArgs {
  let pr: number | undefined;
  const threadIds: string[] = [];
  let text: string | undefined;
  let file: string | undefined;
  let post = false;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--pr": {
        pr = numberAfter(argv, ++i, flag, SWEEP_USAGE);
        break;
      }
      case "--thread": {
        threadIds.push(valueAfter(argv, ++i, flag, SWEEP_USAGE));
        break;
      }
      case "--body": {
        text = valueAfter(argv, ++i, flag, SWEEP_USAGE);
        if (text.trim() === "") {
          throw new Error(`a disposition body must not be blank\n${SWEEP_USAGE}`);
        }
        break;
      }
      case "--body-file": {
        file = valueAfter(argv, ++i, flag, SWEEP_USAGE);
        break;
      }
      case "--post": {
        post = true;
        break;
      }
      default:
        throw new Error(`unknown argument '${String(flag)}'\n${SWEEP_USAGE}`);
    }
  }

  if (pr === undefined) throw new Error(`a --pr is required\n${SWEEP_USAGE}`);
  if (threadIds.length === 0) {
    throw new Error(`at least one --thread is required\n${SWEEP_USAGE}`);
  }
  if (text !== undefined && file !== undefined) {
    throw new Error(`--body and --body-file are mutually exclusive\n${SWEEP_USAGE}`);
  }
  if (text === undefined && file === undefined) {
    throw new Error(`a disposition body is required (--body or --body-file)\n${SWEEP_USAGE}`);
  }
  const body = text !== undefined ? { text } : { file: file as string };
  return { pr, threadIds, body, post };
}

export const GATE_USAGE = "usage: sweep gate --pr <number> --sha <sha>";

/**
 * Parses `sweep gate --pr <n> --sha <sha>`.
 *
 * `--sha` is the head whose check-runs were read green, supplied by the caller
 * that verified them. It is required rather than re-derived here: the gate
 * compares what the PR stands at now against what was verified, and a gate
 * that fetched its own head to compare with would have nothing to compare.
 */
export function parseGateArgs(argv: readonly string[]): GateArgs {
  let pr: number | undefined;
  let head: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--pr": {
        pr = numberAfter(argv, ++i, flag, GATE_USAGE);
        break;
      }
      case "--sha": {
        head = valueAfter(argv, ++i, flag, GATE_USAGE);
        break;
      }
      default:
        throw new Error(`unknown argument '${String(flag)}'\n${GATE_USAGE}`);
    }
  }

  if (pr === undefined) throw new Error(`a --pr is required\n${GATE_USAGE}`);
  if (head === undefined) throw new Error(`a --sha is required\n${GATE_USAGE}`);
  return { pr, head };
}

/** `sweep attribute --pr <n>`: the PR whose github-actions threads will be split by workflow. */
export interface AttributeArgs {
  readonly pr: number;
}

export const ATTRIBUTE_USAGE = "usage: sweep attribute --pr <number>";

/**
 * Parses `sweep attribute --pr <n>`.
 *
 * The PR is the only input: the head branch, the three PR-Agent workflow
 * runs, and the threads all follow from it. Anything else on the command
 * line is a mistake, not an option, because a guessed flag would look like
 * a filter the tool does not have.
 */
export function parseAttributeArgs(argv: readonly string[]): AttributeArgs {
  let pr: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--pr": {
        pr = numberAfter(argv, ++i, flag, ATTRIBUTE_USAGE);
        break;
      }
      default:
        throw new Error(`unknown argument '${String(flag)}'\n${ATTRIBUTE_USAGE}`);
    }
  }

  if (pr === undefined) throw new Error(`a --pr is required\n${ATTRIBUTE_USAGE}`);
  return { pr };
}
