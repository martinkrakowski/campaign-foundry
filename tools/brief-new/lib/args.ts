/**
 * `yarn brief:new` — the brief a sandboxed lane is dispatched with, drafted from
 * the skeleton Template F defines.
 *
 * No forge field reaches this tool: every value below is a caller's own typing,
 * and the parser's only job is to refuse a command line it cannot act on BEFORE
 * anything is read or written. An argv mistake is exit 2 and costs no read of
 * the `--env-file`; a mistyped `--out` that got as far as the write would have
 * spent it, and a `--lane` carrying a line break would have spent the whole
 * brief.
 *
 * The helper shape here is `tools/fix-brief`'s — `valueAfter`,
 * `headerValueAfter`, `NOT_ONE_LINE` — copied rather than imported, because
 * those three are module-private to that tool and that tool's `template.ts`
 * belongs to another lane. The rules they encode are the same rules: one value
 * per flag, one line per value that is written into a brief.
 */
import { isAbsolute } from "node:path";

/** The two hosts a brief can be written for. No other value is a host here. */
export type Host = "midnight" | "mac";

const HOSTS: readonly Host[] = ["midnight", "mac"];

/**
 * Every field the header of the brief Template F defines needs, and nothing
 * about the brief's own prose: `<gap>`, `<notes>`, `<targeted commands>` and
 * `<commit subject>` are the orchestrator's to fill and this tool never sees
 * them.
 */
export interface BriefNewArgs {
  readonly lane: string;
  readonly plan: string;
  readonly worktree: string;
  readonly branch: string;
  readonly tip: string;
  readonly host: Host;
  readonly out: string;
  /** Absent means the environment block is left as its single placeholder line. */
  readonly envFile?: string;
}

export const BRIEF_NEW_USAGE =
  "usage: brief:new --lane <id> --plan <path> --worktree <abs path> --branch <name> " +
  "--tip <sha> --host <midnight|mac> --out <local path> [--env-file <path>]";

/**
 * Reads the value that must follow a long option, or fails with the caller's
 * usage line. An EMPTY value is refused here and not further down: `""` is a
 * flag the caller believes they set, and a brief headed by an empty lane id is a
 * brief nobody can dispatch.
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

/**
 * What may NOT appear in a value the brief's header will carry: a line break, a
 * line or paragraph separator, or any other control character.
 *
 * These four values are the only ones this tool writes into the brief's header,
 * and they are written verbatim — one per line, with no quoting. A `--lane`
 * carrying a newline is not a lane id with a newline in it; it is a second line
 * of the brief, and `## Item 4` on that line is an item heading, and anything
 * after it is read as this brief's own instructions by whoever is dispatched
 * with the file. There is nothing to sanitise here — no forge field reaches this
 * brief — so a value like this is refused (exit 2) rather than quietly mangled
 * into `?`.
 *
 * A backtick is NOT in this class. It cannot end a line — the header's lines are
 * its own — and refusing it would refuse a branch name that legitimately contains
 * one, with nothing to buy.
 */
const NOT_ONE_LINE = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/**
 * Reads a value that the brief's header will carry, and refuses one that would
 * write a line of its own. `--out`, `--env-file` and `--host` are deliberately NOT
 * read this way: none of the three is substituted into the brief — `--out` is a
 * `writeFile` path and a log line, `--env-file` is a `readFile` path, and
 * `--host` picks one of two constant blocks — so refusing a control character in
 * any of them would stop a call whose output cannot be affected by it.
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

/** Whether a `--host` value names one of the two hosts this tool knows. */
function isHost(value: string): value is Host {
  return HOSTS.some((host) => host === value);
}

/** A `--host` that names a host this tool knows, or a refusal naming it. */
function hostAfter(argv: readonly string[], i: number, flag: string, usage: string): Host {
  const raw = valueAfter(argv, i, flag, usage);
  if (!isHost(raw)) {
    throw new Error(`${flag} wants midnight or mac, got '${raw}'\n${usage}`);
  }
  return raw;
}

/**
 * A `--worktree` that is absolute, or a refusal naming it. Read through
 * {@link headerValueAfter} first, so a worktree carrying a line break is refused
 * for being two lines and not for being a relative path that happens to contain
 * one.
 */
function absoluteAfter(argv: readonly string[], i: number, flag: string, usage: string): string {
  const raw = headerValueAfter(argv, i, flag, usage);
  if (!isAbsolute(raw)) {
    throw new Error(
      `${flag} must be an absolute path: the brief's first bullet is where the lane works\n${usage}`,
    );
  }
  return raw;
}

/**
 * Parses `brief:new --lane <id> --plan <path> --worktree <abs path> --branch <name>
 * --tip <sha> --host <midnight|mac> --out <path> [--env-file <path>]`.
 *
 * The checks here that are not the shared pattern's are these three, and each is
 * deliberate:
 *
 * - **A flag given twice** is refused (2). Every flag here states one value, so a
 *   second one is a caller whose script appended to a command line rather than
 *   composing it, and taking the last value would hide that.
 * - **`--host` is exactly `midnight` or `mac`** (2). It is not a free string: it
 *   picks one of two verification blocks, and there is no third block to fall
 *   back to. A typo that named a host this tool has never heard of would
 *   otherwise have produced a brief whose verification section was empty, and an
 *   empty verification section is the one omission a lane cannot notice.
 * - **`--worktree` is absolute** (2). The brief's first bullet is where the lane
 *   does all of its work, and a relative path is read against whatever directory
 *   the agent happens to be in — which is exactly the mistake that costs a lane
 *   its whole run.
 */
export function parseBriefNewArgs(argv: readonly string[]): BriefNewArgs {
  const seen = new Set<string>();
  const once = (flag: string): void => {
    if (seen.has(flag)) {
      throw new Error(`${flag} is given twice, and each flag states one value\n${BRIEF_NEW_USAGE}`);
    }
    seen.add(flag);
  };

  let lane: string | undefined;
  let plan: string | undefined;
  let worktree: string | undefined;
  let branch: string | undefined;
  let tip: string | undefined;
  let host: Host | undefined;
  let out: string | undefined;
  let envFile: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--lane":
        once(flag);
        lane = headerValueAfter(argv, ++i, flag, BRIEF_NEW_USAGE);
        break;
      case "--plan":
        once(flag);
        plan = headerValueAfter(argv, ++i, flag, BRIEF_NEW_USAGE);
        break;
      case "--worktree":
        once(flag);
        worktree = absoluteAfter(argv, ++i, flag, BRIEF_NEW_USAGE);
        break;
      case "--branch":
        once(flag);
        branch = headerValueAfter(argv, ++i, flag, BRIEF_NEW_USAGE);
        break;
      case "--tip":
        once(flag);
        tip = headerValueAfter(argv, ++i, flag, BRIEF_NEW_USAGE);
        break;
      case "--host":
        once(flag);
        host = hostAfter(argv, ++i, flag, BRIEF_NEW_USAGE);
        break;
      case "--out":
        once(flag);
        out = valueAfter(argv, ++i, flag, BRIEF_NEW_USAGE);
        break;
      case "--env-file":
        once(flag);
        envFile = valueAfter(argv, ++i, flag, BRIEF_NEW_USAGE);
        break;
      default:
        throw new Error(`unknown argument '${String(flag)}'\n${BRIEF_NEW_USAGE}`);
    }
  }

  if (lane === undefined) throw new Error(`a --lane is required\n${BRIEF_NEW_USAGE}`);
  if (plan === undefined) throw new Error(`a --plan is required\n${BRIEF_NEW_USAGE}`);
  if (worktree === undefined) throw new Error(`a --worktree is required\n${BRIEF_NEW_USAGE}`);
  if (branch === undefined) throw new Error(`a --branch is required\n${BRIEF_NEW_USAGE}`);
  if (tip === undefined) throw new Error(`a --tip is required\n${BRIEF_NEW_USAGE}`);
  if (host === undefined) throw new Error(`a --host is required\n${BRIEF_NEW_USAGE}`);
  if (out === undefined) throw new Error(`an --out is required\n${BRIEF_NEW_USAGE}`);
  return {
    lane,
    plan,
    worktree,
    branch,
    tip,
    host,
    out,
    ...(envFile === undefined ? {} : { envFile }),
  };
}
