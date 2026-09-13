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

/** Reads the value that must follow a long option, or fails. */
function valueAfter(argv: readonly string[], i: number, flag: string): string {
  const raw = argv[i];
  if (raw === undefined || raw.startsWith("--")) {
    throw new Error(`missing value for ${flag}\n${SWEEP_USAGE}`);
  }
  return raw;
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
        const raw = valueAfter(argv, ++i, flag);
        if (!/^\d+$/.test(raw)) {
          throw new Error(`--pr wants a number, got '${raw}'\n${SWEEP_USAGE}`);
        }
        pr = Number(raw);
        break;
      }
      case "--thread": {
        threadIds.push(valueAfter(argv, ++i, flag));
        break;
      }
      case "--body": {
        text = valueAfter(argv, ++i, flag);
        if (text.trim() === "") {
          throw new Error(`a disposition body must not be blank\n${SWEEP_USAGE}`);
        }
        break;
      }
      case "--body-file": {
        file = valueAfter(argv, ++i, flag);
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
