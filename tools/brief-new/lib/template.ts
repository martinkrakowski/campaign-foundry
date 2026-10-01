import type { Host } from "./args.js";

/**
 * Template F, byte for byte: the lines strictly between the ````markdown fence
 * lines of the "Template F — Lane brief for a sandboxed lane" section in
 * `docs/workflows/delegated-implementation-pipeline.md`. Every placeholder is
 * intact and there is NO trailing newline — the last content line's own newline
 * belongs to the closing fence.
 *
 * It lives here exactly once. `render` substitutes the seven names below and
 * leaves the four prose placeholders the orchestrator owns, and a test asserts
 * this constant equals the doc's block byte for byte, so the template the
 * orchestrator reads and the text this tool writes cannot drift apart without a
 * red test.
 *
 * The backticks are escaped here because a template literal is how a block of
 * markdown gets into a TypeScript file at all; what the escape produces is a
 * backtick in the string, which is why the constant still equals the doc.
 */
export const TEMPLATE_F = `# Lane <LANE> — brief

- **Worktree (absolute, on this server):** <WORKTREE>
- **Branch:** <BRANCH>, checked out at origin/main <TIP> (the plan row is current in this tree). Read the row IN FULL: \`grep -n '<LANE>' <PLAN>\`, then read that whole line. It is long; do not stop at the first 2,000 characters. No PR exists; you do NOT push or open one.
- **The row is the spec:** its enumerated items, tests, mutation, Owns and Must-not are all required. The notes below are clarifications, and the row wins on any conflict.

Environment, for every shell call:

<ENV>

Midnight runs a test Postgres and lanes run against it: set
\`TEST_PG_URL=postgres://cf_test@127.0.0.1:5433/postgres\` in the block above. The server uses
SCRAM, so the credential comes from the operator's \`~/.pgpass\` — never in a URL, a brief or an env
line. Without it every pg test silently ran on PGlite instead: on HXF3's two harness files, 108 s
with 22 timeouts, against 11 s and 53/53.

## First: prove the gap

<gap>

## Notes
<notes>

## Working rules
- \`.agents/briefs/\` is gitignored; run \`mkdir -p .agents/briefs/scratch\` first. Put scratch files there, and never stage anything under \`.agents/briefs/\`.
- **The host lock is shared** (other lanes run here). On exit 75 with \`gate-lock: busy\`, sleep 60 and retry, up to 20 times; if still busy, report the timeout and \`sh scripts/gate-lock.sh status\` output. NEVER remove a lock: a lock is released by its own \`run\`, and a child you started is released in a \`finally\`.
- **Mutations** go through \`sh scripts/gate-lock.sh run <LANE> -- yarn mutate …\`, writing \`--because\` FIRST. \`command\` is an argv array; see \`.agents/manifests/<LANE>.json\`. Each \`before\` must be a unique anchor.
- **Coverage:** under an agent, vitest's coverage TEXT table hides fully covered files, so read \`coverage/coverage-summary.json\` (\`--coverage.reporter=json-summary\`).
- Never call the real GitHub API or \`gh\`, and never spawn a CLI under test: call it in-process with injected I/O.

### Concurrency checklist (locks, signals, async setup/cleanup, shared test state)

If this lane touches a lock, a signal, an async setup or a cleanup, or shared test state, walk all
five before you call it done. Three of them are wave-w01 defects that shipped.

- **(a)** Re-check ownership or staleness **after the LAST \`await\` or \`wait\`**, immediately before
  you act on the shared state — never on entry. #642 (HXF3) adopted the database before the
  org-seed \`await\`.
- **(b)** Set an "attempted" or "done" flag **immediately before the action it records**, never on
  entry. #641 (MH5) set the release flag before the heartbeat \`wait\`.
- **(c)** A shell \`wait\` or \`sleep\` is **interrupted by a trapped signal**: the trap runs inside it,
  not after it. Trace what each trap does at each such point.
- **(d)** A cleanup can run **twice or late** — a second actor, a timeout, a crash handler — so it
  must be **read-only on state it does not own**. #639 (MH4) had a refused acquire give back a slot
  no longer its own.
- **(e)** For **each** of those points, one test that **stacks a second actor there**. The same path
  run twice with nothing else changed is not that test, and it is the only thing that catches
  (a)–(d).

## Verification
<VERIFICATION>

## Commit

Commit only the row's Owns paths. Stage explicit paths, never \`git add -A\`. Conventional Commits, e.g. \`<commit subject>\`. No trailers. Never use \`-c core.hooksPath\` or \`--no-verify\`.

## Must not

- anything in the row's Must-not column;
- push, open a PR, rebase, merge or stash;
- edit \`AGENTS.md\`, \`.agents/*.md\` or \`yarn.lock\`;
- add a dependency.

## Report

Report the commit SHA(s), each command's exit code and key output, the coverage rows, every mutation verdict, and the wall time per step.

If a finding is wrong, say so with the mechanism rather than changing code to match it.
Run every verification command in the foreground and read its exit code. A task you launched is not a result.`;

/**
 * The midnight verification block: the host that cannot pass the full suite, so
 * a lane there is told not to try and to run its own targeted commands in the
 * foreground instead.
 *
 * The middle line is a placeholder and stays one. `<targeted commands>` is the
 * orchestrator's to fill — the commands are per lane and this tool has no way to
 * know them — and it is NOT one of the seven names `substitute` fills, so it
 * reaches the file as the word the orchestrator will search for.
 */
export const VERIFICATION_MIDNIGHT =
  "**Do NOT run `yarn gate` or `yarn test:cov`** (this host cannot pass the full suite; GitHub CI is the gate). Run, in the FOREGROUND, reading each exit code:\n<targeted commands>";

/**
 * The mac verification block: the same targeted commands, and then the whole
 * gate. `<LANE>` sits in the gate-lock command, and {@link verificationFor} has
 * already put the lane's own id there before the single substitution pass runs —
 * so no `<LANE>` survives literally into a written brief.
 */
export const VERIFICATION_MAC =
  "<targeted commands>\nThen run `yarn gate --lane <LANE>` in the FOREGROUND, reading its exit code.";

/**
 * The verification block for one host, with the lane's own id in place.
 *
 * The id is substituted HERE rather than left in the block for `substitute` to
 * find, and that is what keeps the substitution single-pass: `<VERIFICATION>`'s
 * replacement is not itself scanned for `<LANE>`, so an id that arrived first has
 * to have the lane already in it. One `replace` over the two hosts' own text, and
 * the block this returns carries no placeholder the seven-name pass would miss.
 */
export function verificationFor(host: Host, lane: string): string {
  const block = host === "midnight" ? VERIFICATION_MIDNIGHT : VERIFICATION_MAC;
  return block.replace(/<LANE>/g, lane);
}

/** What `<ENV>` becomes when no `--env-file` was given: the block's one placeholder line. */
export const ENV_PLACEHOLDER = "    <the exports every shell call needs>";

/**
 * Four spaces, because `<ENV>`'s value is an INDENTED code block and every line
 * of it has to be inside. A line that left the block would be prose in the
 * middle of a brief — an export on its own line, unquoted, where a reader would
 * take it as instructions rather than as the environment it is.
 */
const ENV_INDENT = "    ";

/** Tab: the one control character an environment line may carry. */
const TAB = "\t";

/** What may not appear in an environment line, once tabs are set aside. */
const NOT_ONE_ENV_LINE = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/**
 * The control character an environment line carries, or `undefined`.
 *
 * A CR is the one that bites: an env file written on Windows ends every line with
 * one, and it would land the carriage return inside the brief's own line endings.
 * A NUL truncates the line for every reader downstream of the write. Both are
 * refused with the line number rather than mangled, because the file is a
 * caller's own typing and there is nothing here to sanitise.
 */
function badEnvChar(line: string): string | undefined {
  for (const char of line) {
    if (char === TAB) continue;
    if (NOT_ONE_ENV_LINE.test(char)) return char;
  }
  return undefined;
}

/**
 * `--env-file`'s lines, or a refusal naming the line that stopped them.
 *
 * Exactly one trailing newline is dropped first, and only one: that is the file's
 * own terminator, and dropping every one would silently discard a blank line the
 * caller wrote on purpose.
 */
export function envLinesFrom(raw: string): readonly string[] {
  const body = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (body.trim() === "") {
    throw new Error(
      "a --env-file must carry at least one export: the environment block would be empty, and an empty environment block is the one omission a lane cannot notice",
    );
  }
  const lines = body.split("\n");
  for (const [index, line] of lines.entries()) {
    if (badEnvChar(line) !== undefined) {
      throw new Error(
        `--env-file line ${index + 1} carries a control character (CR, NUL, or another), and only a tab is allowed in the brief's environment block`,
      );
    }
  }
  return lines;
}

/** The environment block, every line of it indented into the code block. */
export function environmentBlock(lines: readonly string[]): string {
  return lines.map((line) => `${ENV_INDENT}${line}`).join("\n");
}

/** The seven names this tool fills; nothing else it touches is a placeholder. */
export type Placeholder = "LANE" | "PLAN" | "WORKTREE" | "BRANCH" | "TIP" | "ENV" | "VERIFICATION";

/**
 * Fills the template's own placeholders, in ONE pass.
 *
 * One pass is the whole point. Filling them one name at a time means the text a
 * name introduces is itself scanned for the remaining ones, so an operator value
 * that happens to read `<PLAN>` — a lane id chosen to look like a template, a
 * branch called `<LANE>` — is substituted a second time and the brief goes out
 * with a value nobody typed. A single replace over every name at once cannot do
 * that: the replacement is never rescanned.
 *
 * The alternation and the FUNCTION replacer are both load-bearing. A string
 * replacer would interpret `$&` in a branch name as the whole match, so a branch
 * called `feat/$&` would come out as `feat/<LANE>`; the function form is handed
 * the text and returns it untouched.
 *
 * There is no fallback for an unknown name, because the pattern only matches the
 * seven names above and {@link Placeholder} is the whole of them: a fallback
 * would be a name no input can reach, and a silent one at that.
 */
export function substitute(text: string, values: Readonly<Record<Placeholder, string>>): string {
  return text.replace(
    /<(LANE|PLAN|WORKTREE|BRANCH|TIP|ENV|VERIFICATION)>/g,
    (_, name: string) => values[name as Placeholder],
  );
}

/** Everything the header needs, and nothing about the brief's own prose. */
export interface BriefHeader {
  readonly lane: string;
  readonly plan: string;
  readonly worktree: string;
  readonly branch: string;
  readonly tip: string;
  readonly host: Host;
}

/**
 * The whole brief: Template F with its seven placeholders filled.
 *
 * `envLines` absent means the caller passed no `--env-file`, and `<ENV>` is left
 * as the block's own placeholder line — the orchestrator pastes the exports in.
 * Absent is NOT the same as an empty list, which `envLinesFrom` refuses rather
 * than rendering as no block at all.
 */
export function render(header: BriefHeader, envLines?: readonly string[]): string {
  const values: Readonly<Record<Placeholder, string>> = {
    LANE: header.lane,
    PLAN: header.plan,
    WORKTREE: header.worktree,
    BRANCH: header.branch,
    TIP: header.tip,
    ENV: envLines === undefined ? ENV_PLACEHOLDER : environmentBlock(envLines),
    VERIFICATION: verificationFor(header.host, header.lane),
  };
  return substitute(TEMPLATE_F, values);
}
