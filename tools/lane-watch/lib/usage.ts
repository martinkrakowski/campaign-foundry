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

  let body: SessionShape;
  try {
    body = (await response.json()) as SessionShape;
  } catch (error) {
    io.logError(`lane:watch: session ${session} did not return JSON: ${errorText(error)}`);
    return { code: EXIT_FAILED, usage: null };
  }

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

  const missing: string[] = [];
  if (tokens === undefined) missing.push("tokens");
  if (body.cost === undefined) missing.push("cost");
  if (missing.length > 0) {
    io.logError(
      `lane:watch: the server did not report ${missing.join(" and ")} for ${session} — printed ` +
        `as null, which is "unknown" and not a zero (exit ${EXIT_UNKNOWN})`,
    );
    return { code: EXIT_UNKNOWN, usage };
  }
  return { code: EXIT_OK, usage };
}
