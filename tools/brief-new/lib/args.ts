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
 * What may NOT appear in a value that is written into the brief's header: a line
 * break, a line or paragraph separator, or any other control character.
 *
 * This is now ONE value's rule — `--worktree` — because the other three header
 * values are held to a character class instead ({@link safeValueAfter}), and a
 * class that admits no control character has nothing left for this one to catch.
 *
 * `--worktree` is written into a bullet as plain text, with no quoting and no
 * shell anywhere around it, so the only way it could write a line of its own is by
 * carrying one: a value with a newline in it is not a path with a newline in it; it
 * is a second line of the brief, and `## Must not` on that line is read as this
 * brief's own instructions by whoever is dispatched with the file. There is nothing
 * to sanitise here — no forge field reaches this brief — so a value like that is
 * refused (exit 2) rather than quietly mangled into `?`.
 *
 * A backtick is NOT in this class, and for `--worktree` that is the whole argument:
 * `<WORKTREE>` sits in no code span, so a backtick in the path cannot close one.
 * The three values that DO sit in code spans — the lane, the plan and the branch —
 * are refused a backtick by their own classes, which is what this paragraph was
 * arguing about before it only had to argue about one value.
 */
const NOT_ONE_LINE = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/** A character class, and the words a refusal quotes when a value is outside it. */
interface SafeClass {
  readonly pattern: RegExp;
  readonly wants: string;
}

/**
 * `--lane`: an id, and the class `scripts/wave-event.sh` itself refuses a lane
 * outside of (`token_re` at line 152), so a lane id this tool writes is one that
 * script can be handed.
 */
const LANE_CLASS: SafeClass = {
  pattern: /^[A-Za-z0-9_-]+$/,
  wants: "an id: letters, digits, _ and -",
};

/**
 * `--plan` and `--branch`: repository paths and branch names, which is every
 * character below and nothing else.
 */
const PATH_CLASS: SafeClass = {
  pattern: /^[A-Za-z0-9._/-]+$/,
  wants: "a path: letters, digits and . _ / -",
};

/**
 * `--tip`: a git sha as the brief states it, so hex and 7 to 40 characters — the
 * range `git rev-parse --short` and a full sha produce, and nothing else. A value
 * past 40 is a concatenation or a paste of two, not a sha.
 */
const SHA_CLASS: SafeClass = {
  pattern: /^[0-9a-f]{7,40}$/,
  wants: "a git sha: 7 to 40 hex digits",
};

/**
 * Reads a value that is substituted into the brief, and refuses one outside its
 * class.
 *
 * A class and not "one line", because these four values do not merely end up on a
 * line of prose: `<LANE>` and `<PLAN>` land in an UNQUOTED
 * `grep -n '<LANE>' <PLAN>`, and `<LANE>`, `<PLAN>` and `<BRANCH>` each land in a
 * backtick code span. A space in a plan path makes that grep name two files; a `$`
 * starts a shell expansion in it; a backtick ends the code span the value sits in
 * and whatever follows is read as the brief's own text. None of these values is
 * free text — they are an id, two repository paths and a sha — so the cheap
 * refusal is to say what they are and let anything else be a command-line mistake
 * (exit 2) before a brief is built from it.
 *
 * The refused value is quoted back in the message so a caller can see what they
 * typed, as every other refusal in this file does.
 */
function safeValueAfter(
  argv: readonly string[],
  i: number,
  flag: string,
  rule: SafeClass,
  usage: string,
): string {
  const raw = valueAfter(argv, i, flag, usage);
  if (!rule.pattern.test(raw)) {
    throw new Error(`${flag} wants ${rule.wants}, got '${raw}'\n${usage}`);
  }
  return raw;
}

/**
 * Reads a value that is written into the brief's header as plain text, and refuses
 * one that would write a line of its own. `--worktree` is the only value read this
 * way: it is the one header value no shell and no code span carries it.
 *
 * `--out`, `--env-file` and `--host` are read the plain way above it. None of the
 * three is substituted into the brief — `--out` is a `writeFile` path and a log
 * line, `--env-file` is a `readFile` path, and `--host` picks one of two constant
 * blocks — so refusing a control character in any of them would stop a call whose
 * output cannot be affected by it.
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
 * The checks here that are not the shared pattern's are these four, and each is
 * deliberate:
 *
 * - **A flag given twice** is refused (2). Every flag here states one value, so a
 *   second one is a caller whose script appended to a command line rather than
 *   composing it, and taking the last value would hide that.
 * - **`--lane`, `--plan`, `--branch` and `--tip` are held to a character class**
 *   (2). These four are substituted into the brief, and two of them land in an
 *   unquoted shell command and three in code spans — see {@link safeValueAfter}
 *   for the whole argument, which is about what a space, a `$` and a backtick do
 *   to `grep -n '<LANE>' <PLAN>` and to the span around it.
 * - **`--host` is exactly `midnight` or `mac`** (2). It is not a free string: it
 *   picks one of two verification blocks, and there is no third block to fall
 *   back to. A typo that named a host this tool has never heard of would
 *   otherwise have produced a brief whose verification section was empty, and an
 *   empty verification section is the one omission a lane cannot notice.
 * - **`--worktree` is absolute** (2), and one line. The brief's first bullet is
 *   where the lane does all of its work, and a relative path is read against
 *   whatever directory the agent happens to be in — which is exactly the mistake
 *   that costs a lane its whole run. It keeps the one-line rule rather than a
 *   class because no shell or code span carries it; see {@link NOT_ONE_LINE}.
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
        lane = safeValueAfter(argv, ++i, flag, LANE_CLASS, BRIEF_NEW_USAGE);
        break;
      case "--plan":
        once(flag);
        plan = safeValueAfter(argv, ++i, flag, PATH_CLASS, BRIEF_NEW_USAGE);
        break;
      case "--worktree":
        once(flag);
        worktree = absoluteAfter(argv, ++i, flag, BRIEF_NEW_USAGE);
        break;
      case "--branch":
        once(flag);
        branch = safeValueAfter(argv, ++i, flag, PATH_CLASS, BRIEF_NEW_USAGE);
        break;
      case "--tip":
        once(flag);
        tip = safeValueAfter(argv, ++i, flag, SHA_CLASS, BRIEF_NEW_USAGE);
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
