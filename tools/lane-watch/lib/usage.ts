import { EXIT_FAILED, EXIT_OK, EXIT_UNKNOWN, errorText } from "./errors.js";
import { sessionPath, type Get } from "./server.js";
import type { SessionShape, Usage } from "./types.js";
import type { UsageArgs } from "./args.js";

/** `readUsage`'s dependencies. The signal is the caller's, aborted on every exit. */
export interface UsageIo {
  readonly get: Get;
  readonly signal: AbortSignal;
  readonly log: (text: string) => void;
  readonly logError: (text: string) => void;
}

/**
 * Renders the usage line.
 *
 * The field names are the row's, verbatim (`tokens_in`, `cache_read`, …), so
 * this output can be read against the row without a translation step.
 * `JSON.stringify` renders `null` as `null`, which is this tool's "the server
 * did not say" — never a 0, and never a 0 a later reader cannot tell from a
 * real zero.
 */
function renderUsage(usage: Usage): string {
  return (
    `secs=${usage.secs} tokens_in=${usage.tokens_in} tokens_out=${usage.tokens_out} ` +
    `reasoning=${usage.reasoning} cache_read=${usage.cache_read} ` +
    `cache_write=${usage.cache_write} cost=${usage.cost} ` +
    `title=${JSON.stringify(usage.title)} directory=${JSON.stringify(usage.directory)}`
  );
}

/** A number the server sent, or `null` for "it did not say". Never a guessed 0. */
function reported(value: number | undefined): number | null {
  return value ?? null;
}

/**
 * What the read concluded, and the record it built.
 *
 * `usage` is non-null whenever a body was read, INCLUDING on the exit-3 that
 * says the body was incomplete: the line is printed before the 3 is decided,
 * so an operator watching a lane sees what the server DID say. It is null on
 * every exit 1, because there was no body to read.
 */
export interface UsageResult {
  readonly code: number;
  readonly usage: Usage | null;
}

/**
 * Reads one session and reports what it cost.
 *
 * Exit codes, and the reasoning behind the two that are not 0/1:
 *
 * - 0 — the usage was read and is printed.
 * - 1 — the session is not there (404), or the read failed. The id is named,
 *   because "the lane never started" and "the lane finished and its session
 *   was reaped" are different facts and the operator acts on them differently.
 * - 3 — the server did not report `tokens` or `cost`. This is neither a
 *   failure nor a zero. `scripts/lane-usage.sh` reads those columns out of
 *   opencode's SQLite and prints 0 for a row that is not there yet, which is
 *   how a lane that has not billed anything came to look identical to a lane
 *   that billed nothing. `null` is printed instead, and 3 is returned so a
 *   script can tell "unknown" from "zero" without parsing prose.
 *
 * The line is printed BEFORE the 3 is decided, so an operator watching a lane
 * sees what the server did say even on the exit that says it did not say
 * everything.
 */
export async function readUsage(args: UsageArgs, io: UsageIo): Promise<UsageResult> {
  const session = args.session;
  let response: Response;
  try {
    response = await io.get(sessionPath(session), io.signal);
  } catch (error) {
    io.logError(`lane:watch: the session read failed: ${errorText(error)}`);
    return { code: EXIT_FAILED, usage: null };
  }
  if (response.status === 404) {
    io.logError(`lane:watch: no such session: ${session} (the server answered 404)`);
    return { code: EXIT_FAILED, usage: null };
  }
  if (response.status !== 200) {
    io.logError(`lane:watch: the server answered ${response.status} for session ${session}`);
    return { code: EXIT_FAILED, usage: null };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    io.logError(`lane:watch: session ${session} did not return JSON: ${errorText(error)}`);
    return { code: EXIT_FAILED, usage: null };
  }
  // A 200 whose body is JSON but not a session OBJECT is an unusable response,
  // not an incomplete one. `null` throws on the first property read, and a
  // number, string or array falls through to the exit-3 branch as though the
  // server had reported a session with no tokens. Both misattribute the fault:
  // one reaches the CLI's usage-error arm and exits 2, telling the operator
  // their command line was wrong when the server was; the other exits 3,
  // "unreported", when the truth is that there was nothing to report on.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    io.logError(`lane:watch: session ${session} did not return a session object`);
    return { code: EXIT_FAILED, usage: null };
  }
  const body = parsed as SessionShape;

  const tokens = body.tokens;
  const created = body.time?.created;
  const updated = body.time?.updated;
  const usage: Usage = {
    secs:
      typeof created === "number" && typeof updated === "number"
        ? Math.floor((updated - created) / 1000)
        : null,
    tokens_in: reported(tokens?.input),
    tokens_out: reported(tokens?.output),
    reasoning: reported(tokens?.reasoning),
    cache_read: reported(tokens?.cache?.read),
    cache_write: reported(tokens?.cache?.write),
    cost: reported(body.cost),
    title: body.title ?? "",
    directory: body.directory ?? "",
  };

  io.log(args.json ? JSON.stringify(usage) : renderUsage(usage));

  const missing = unreported(body);
  if (missing.length > 0) {
    io.logError(
      `lane:watch: the server did not report ${missing.join(" and ")} for ${session} — printed ` +
        `as null, which is "unknown" and not a zero (exit ${EXIT_UNKNOWN})`,
    );
    return { code: EXIT_UNKNOWN, usage };
  }
  return { code: EXIT_OK, usage };
}

/**
 * The five token counts, named for the message, in the order the row lists them.
 *
 * They are read as a LIST rather than tested one at a time so the
 * completeness decision below has exactly ONE predicate to keep in step with
 * what is printed: a count that is not a number is unreported, whether it is
 * absent, `null`, or the wrong type entirely.
 */
const TOKEN_COUNTS: readonly (readonly [
  string,
  (tokens: NonNullable<SessionShape["tokens"]>) => unknown,
])[] = [
  ["input", (tokens) => tokens.input],
  ["output", (tokens) => tokens.output],
  ["reasoning", (tokens) => tokens.reasoning],
  ["cache.read", (tokens) => tokens.cache?.read],
  ["cache.write", (tokens) => tokens.cache?.write],
];

/**
 * What the server did not report, named — and the ONE completeness predicate.
 *
 * A reading is complete only when every token count AND `cost` is a number.
 *
 * Testing the top-level `tokens` object instead was the bug: `tokens: {}` with
 * a cost satisfied `tokens !== undefined`, so a record printed with five
 * `null`s and a real cost exited 0 — and with `--emit` that incomplete reading
 * was appended to the wave as a clean `settled` event under a success code.
 * `null` for either field failed the same test the other way round, exiting 0
 * for a record that said nothing.
 *
 * `secs` is deliberately NOT in this list. The row names only tokens and cost
 * for exit 3, and a session with no `time` is a session whose duration the
 * server has not published — the totals may still be complete, and refusing to
 * report them over a missing clock would discard a reading that is mostly
 * there. `secs` prints as `null` and the exit stays 0.
 */
function unreported(body: SessionShape): readonly string[] {
  const missing: string[] = [];
  const tokens = body.tokens;
  if (tokens === undefined || tokens === null) {
    // The whole object is absent, so the object is what the message names —
    // not five counts the server was never asked for.
    missing.push("tokens");
  } else {
    for (const [name, read] of TOKEN_COUNTS) {
      if (typeof read(tokens) !== "number") missing.push(`tokens.${name}`);
    }
  }
  if (typeof body.cost !== "number") missing.push("cost");
  return missing;
}
