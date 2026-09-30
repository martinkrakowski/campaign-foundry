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
  // Digits are not a number. `0` is no PR and no round; a value past the safe
  // integer limit is silently rounded, so `--pr 9007199254740993` would ask the
  // forge about a PR that is not the one the caller named and be told nothing
  // useful; and a 400-digit run of them converts to Infinity, which
  // `--round` would then write into a brief's own header as the word
  // "Infinity". Both are argv mistakes, so both stop here, where the caller can
  // see the spelling they typed, rather than at the forge.
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${flag} wants a positive whole number, got '${raw}'\n${usage}`);
  }
  return value;
}

/**
 * What may NOT appear in a value the brief's header will carry: a line break, a
 * line or paragraph separator, or any other control character.
 *
 * These four values are the only ones this tool writes into the brief, and they
 * are written verbatim — one per line, with no quoting. A `--lane` carrying a
 * newline is not a lane id with a newline in it; it is a second line of the
 * brief, and `## Item 4` on that line is an item heading, and anything after it
 * is read as this brief's own instructions by whoever is dispatched with the
 * file. `sanitiseInline` exists for fields that arrive from the forge and must
 * be rendered anyway; an argv value is a caller's own typing, so it is refused
 * (exit 2) instead of quietly mangled into `?`.
 *
 * A backtick is NOT in this class. It cannot end a line — the header's lines
 * are its own — and refusing it would refuse a branch name that legitimately
 * contains one, with nothing to buy.
 */
const NOT_ONE_LINE = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/**
 * Reads a value that the brief's header will carry, and refuses one that would
 * write a line of its own. `--out` and `--threads` are deliberately NOT read
 * this way: neither is substituted into the brief — `--out` is a `writeFile`
 * path and a log line, and a `--threads` id must equal a forge thread id or the
 * run refuses with 1 — so refusing a control character there would stop a call
 * whose output cannot be affected by it.
 */
function headerValueAfter(argv: readonly string[], i: number, flag: string, usage: string): string {
  const raw = valueAfter(argv, i, flag, usage);
  if (NOT_ONE_LINE.test(raw)) {
    throw new Error(
      `${flag} must be a single line: it is written into the brief's header verbatim\n${usage}`,
    );
  }
  return raw;
}

/**
 * Parses `fix-brief --pr <n> --lane <id> --round <k> --worktree <abs path>
 * --branch <name> --tip <sha> --out <local path> [--threads <id,id,…>]`.
 *
 * `--round` is a counter, like `--pr`, and is held to the same rule: a round
 * called "next" or "r2" is a label this brief has nowhere to put.
 *
 * The checks here that are NOT in `sweep`'s parser are these three, and each is
 * deliberate — the rest are documented where they live ({@link
 * numberAfter}, {@link headerValueAfter}):
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
        lane = headerValueAfter(argv, ++i, flag, FIX_BRIEF_USAGE);
        break;
      case "--round":
        once(flag);
        round = numberAfter(argv, ++i, flag, FIX_BRIEF_USAGE);
        break;
      case "--worktree":
        once(flag);
        worktree = headerValueAfter(argv, ++i, flag, FIX_BRIEF_USAGE);
        break;
      case "--branch":
        once(flag);
        branch = headerValueAfter(argv, ++i, flag, FIX_BRIEF_USAGE);
        break;
      case "--tip":
        once(flag);
        tip = headerValueAfter(argv, ++i, flag, FIX_BRIEF_USAGE);
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
