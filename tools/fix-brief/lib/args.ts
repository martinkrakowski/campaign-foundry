/**
 * `yarn fix-brief` — the brief a sandboxed lane is dispatched with, drafted
 * from a PR's unresolved review threads.
 *
 * Every field below reaches the header of the brief Template E defines, and
 * the parser's only job is to refuse a command line the tool cannot act on
 * BEFORE anything is fetched: an argv mistake is exit 2 and costs no forge
 * call, and a mistyped `--out` that got as far as the fetch would already have
 * spent it.
 */
export interface FixBriefArgs {
  readonly pr: number;
  readonly lane: string;
  readonly round: number;
  readonly worktree: string;
  readonly branch: string;
  readonly tip: string;
  readonly out: string;
  /** Absent means every UNRESOLVED thread of the PR — the default. */
  readonly threadIds?: readonly string[];
}

export const FIX_BRIEF_USAGE =
  "usage: fix-brief --pr <number> --lane <id> --round <k> --worktree <abs path> " +
  "--branch <name> --tip <sha> --out <local path> [--threads <PRRT_id,PRRT_id,…>]";

/**
 * Reads the value that must follow a long option, or fails with the caller's
 * usage line. An EMPTY value is refused here and not further down: `""` and
 * `--threads ""` are both a flag the caller believes they set, and a brief
 * headed by an empty lane id is a brief nobody can dispatch.
 */
function valueAfter(argv: readonly string[], i: number, flag: string, usage: string): string {
  const raw = argv[i];
  if (raw === undefined || raw.startsWith("--")) {
    throw new Error(`missing value for ${flag}\n${usage}`);
  }
  if (raw.trim() === "") {
    throw new Error(`${flag} was given an empty value\n${usage}`);
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

/**
 * Parses `fix-brief --pr <n> --lane <id> --round <k> --worktree <abs path>
 * --branch <name> --tip <sha> --out <local path> [--threads <id,id,…>]`.
 *
 * `--round` is a counter, like `--pr`, and is held to the same rule: a round
 * called "next" or "r2" is a label this brief has nowhere to put.
 *
 * Three checks here are NOT in `sweep`'s parser, and each is deliberate:
 *
 * - **A flag given twice** is refused (2). `sweep` can take `--thread` twice on
 *   purpose, because one class is several threads; every flag here states one
 *   value, so a second one is a caller whose script appended to a command line
 *   rather than composing it, and taking the last value would hide that.
 * - **`--threads` is ONE comma-separated value.** Spelling it `--threads a,b`
 *   instead of `--thread a --thread b` is what makes a duplicated id visible at
 *   all: after the split, an id that appears twice is a list the caller has to
 *   fix, not a class to dispose.
 * - **A duplicated id in that list** is 2, where `sweep` refuses the same
 *   mistake with 1. The difference is the whole point: `sweep` can only learn a
 *   class member is duplicated by asking the forge, and its 1 means "the class
 *   you asked for cannot be disposed"; here the argv already says it twice, so
 *   the run stops before the first request.
 */
export function parseFixBriefArgs(argv: readonly string[]): FixBriefArgs {
  const seen = new Set<string>();
  const once = (flag: string): void => {
    if (seen.has(flag)) {
      throw new Error(`${flag} is given twice, and each flag states one value\n${FIX_BRIEF_USAGE}`);
    }
    seen.add(flag);
  };

  let pr: number | undefined;
  let lane: string | undefined;
  let round: number | undefined;
  let worktree: string | undefined;
  let branch: string | undefined;
  let tip: string | undefined;
  let out: string | undefined;
  let threadIds: readonly string[] | undefined;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--pr":
        once(flag);
        pr = numberAfter(argv, ++i, flag, FIX_BRIEF_USAGE);
        break;
      case "--lane":
        once(flag);
        lane = valueAfter(argv, ++i, flag, FIX_BRIEF_USAGE);
        break;
      case "--round":
        once(flag);
        round = numberAfter(argv, ++i, flag, FIX_BRIEF_USAGE);
        break;
      case "--worktree":
        once(flag);
        worktree = valueAfter(argv, ++i, flag, FIX_BRIEF_USAGE);
        break;
      case "--branch":
        once(flag);
        branch = valueAfter(argv, ++i, flag, FIX_BRIEF_USAGE);
        break;
      case "--tip":
        once(flag);
        tip = valueAfter(argv, ++i, flag, FIX_BRIEF_USAGE);
        break;
      case "--out":
        once(flag);
        out = valueAfter(argv, ++i, flag, FIX_BRIEF_USAGE);
        break;
      case "--threads": {
        once(flag);
        const ids = valueAfter(argv, ++i, flag, FIX_BRIEF_USAGE)
          .split(",")
          .map((id) => id.trim());
        const problems: string[] = [];
        const unique: string[] = [];
        for (const id of ids) {
          if (id === "") problems.push("--threads carries an empty id");
          else if (unique.includes(id)) problems.push(`${id} is listed twice`);
          else unique.push(id);
        }
        if (problems.length > 0) {
          throw new Error(
            `${problems.join("; ")} — one id each, comma separated\n${FIX_BRIEF_USAGE}`,
          );
        }
        threadIds = unique;
        break;
      }
      default:
        throw new Error(`unknown argument '${String(flag)}'\n${FIX_BRIEF_USAGE}`);
    }
  }

  if (pr === undefined) throw new Error(`a --pr is required\n${FIX_BRIEF_USAGE}`);
  if (lane === undefined) throw new Error(`a --lane is required\n${FIX_BRIEF_USAGE}`);
  if (round === undefined) throw new Error(`a --round is required\n${FIX_BRIEF_USAGE}`);
  if (worktree === undefined) throw new Error(`a --worktree is required\n${FIX_BRIEF_USAGE}`);
  if (branch === undefined) throw new Error(`a --branch is required\n${FIX_BRIEF_USAGE}`);
  if (tip === undefined) throw new Error(`a --tip is required\n${FIX_BRIEF_USAGE}`);
  if (out === undefined) throw new Error(`an --out is required\n${FIX_BRIEF_USAGE}`);
  return {
    pr,
    lane,
    round,
    worktree,
    branch,
    tip,
    out,
    ...(threadIds === undefined ? {} : { threadIds }),
  };
}
