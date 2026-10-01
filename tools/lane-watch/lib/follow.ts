import { EXIT_FAILED, EXIT_OK, EXIT_UNKNOWN, errorText } from "./errors.js";
import { GLOBAL_EVENT_PATH, type Get } from "./server.js";
import { SseParser } from "./sse.js";
import type { EventEnvelope, MessagePart } from "./types.js";
import type { FollowArgs } from "./args.js";

/**
 * A value the server sent, on one compact line.
 *
 * `tokens` on a `step-finish` is rendered through this rather than through a
 * declared shape: the row names the field but not its structure, and a
 * formatter that asserted one would be inventing a contract the row does not
 * make. A number or string prints bare, an object prints as compact JSON, and
 * an absent field prints as the word `unknown` — never a 0.
 */
function compact(value: unknown): string {
  if (value === undefined || value === null) return "unknown";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * An envelope this tool can read a payload off, or `{}` for one it cannot.
 *
 * `JSON.parse` returns whatever the bytes described, including `null`, a bare
 * number and a string. Property access on `null` throws, so this exists so
 * that a frame the server sent as nonsense is DROPPED rather than ending the
 * watch through an exception — an exception out of `follow` reaches the CLI's
 * usage-error arm and exits 2, telling the operator their command line was
 * wrong when the server was at fault.
 */
function asEnvelope(value: unknown): EventEnvelope {
  return typeof value === "object" && value !== null ? (value as EventEnvelope) : {};
}

/**
 * The render layer: prints a progress line, collapsing consecutive identical
 * ones.
 *
 * A tool's state arrives as a STREAM of updates — `running`, `running`,
 * `running` for as long as one command runs — and only the CHANGES say
 * anything. Ten identical updates are one line in the log.
 *
 * The collapse is here, at the render layer, and not in the frame handler,
 * because the handler's verdict is what drives the outcome and what re-arms
 * the stall. Skipping the log call must NOT skip the liveness: each of those
 * ten updates is a live ping from the lane, and a watch that stopped counting
 * them would stall a lane that is working perfectly.
 */
class LineRenderer {
  private previous: string | null = null;
  private readonly log: (text: string) => void;

  constructor(log: (text: string) => void) {
    this.log = log;
  }

  print(line: string): void {
    if (line === this.previous) return;
    this.previous = line;
    this.log(line);
  }
}

/**
 * The pause before a re-subscribe.
 *
 * It goes through the injected `setTimer` rather than a bare `setTimeout`, for
 * the same reason the stall does: only the injected one a fake clock can
 * drive. `reconnectDelayMs` of 0 resolves immediately without arming anything,
 * so the drop tests are not waiting out three backoffs to assert a result.
 */
function waitBeforeReconnect(io: FollowIo): Promise<void> {
  if (io.reconnectDelayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    io.setTimer(resolve, io.reconnectDelayMs);
  });
}

/** `follow`'s dependencies. The signal is the caller's, aborted on every exit. */
export interface FollowIo {
  readonly get: Get;
  readonly signal: AbortSignal;
  readonly log: (text: string) => void;
  readonly logError: (text: string) => void;
  /**
   * The stall timer, injected rather than reached for globally. The stall is a
   * plain `setTimeout` — never `AbortSignal.timeout`, which a fake clock
   * cannot drive, and a test that cannot reach the stall cannot claim to
   * cover it. Injecting it also keeps every global out of this file except
   * `TextDecoder`.
   */
  /**
   * The pause between reconnect attempts, in milliseconds.
   *
   * REQUIRED rather than defaulted, because the two callers that matter want
   * opposite things and a default would silently pick one: the entry wrapper
   * passes a real backoff so a tunnel blip does not spend all four attempts in
   * milliseconds, and every test passes 0 so the drop tests stay instant. A
   * default parameter is not an option here — istanbul counts the default as a
   * branch, and a branch only the tests never take is a branch nothing covers.
   */
  readonly reconnectDelayMs: number;
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
}

/** What one subscription concluded. */
type Outcome = "idle" | "error" | "stalled" | "dropped";

/** The exit code each conclusion maps to. */
const EXIT_FOR: Readonly<Record<Outcome, number>> = {
  idle: EXIT_OK,
  error: EXIT_FAILED,
  stalled: EXIT_UNKNOWN,
  dropped: EXIT_FAILED,
};

/** How many times a dropped stream is re-subscribed before it is a failure. */
export const MAX_RECONNECTS = 3;

/** One frame's conclusion, and whether it named the session being followed. */
interface FrameResult {
  readonly outcome: Outcome | "continue";
  /** True only when the frame named THIS session — what resets the stall. */
  readonly forSession: boolean;
}

/**
 * The step count is state across frames, which is why `follow` holds it rather
 * than the renderer: `step-start` increments it and `step-finish` reports which
 * step finished. A `step-finish` with no `step-start` before it reports step 0,
 * which is visible rather than silently renumbered.
 */
class StepCounter {
  private steps = 0;

  start(): string {
    this.steps += 1;
    return `step ${this.steps} start`;
  }

  finish(reason: string, tokens: unknown, cost: unknown): string {
    return `step ${this.steps} finish reason=${reason} tokens=${compact(tokens)} cost=${compact(cost)}`;
  }
}

const CONTINUE: FrameResult = { outcome: "continue", forSession: false };

/**
 * Decides what one frame means, and prints the lines the row asks for.
 *
 * The session filter is applied FIRST, before any printing, and it is
 * load-bearing: `/global/event` carries every instance's events, so a watch
 * without it ends on another lane's `session.idle` and reports a lane finished
 * that is still running.
 *
 * One deliberate exception, and it is narrow: a `session.error` carrying NO
 * `sessionID` is printed but not attributed, and does not end the watch. The
 * row recorded the field as optional, and a failure nobody can attribute is
 * still a failure the operator should see.
 */
function handleFrame(
  raw: string,
  session: string,
  steps: StepCounter,
  io: Pick<FollowIo, "log" | "logError">,
): FrameResult {
  let envelope: EventEnvelope;
  try {
    envelope = JSON.parse(raw) as EventEnvelope;
  } catch (error) {
    // Not a frame this tool can read. Named, then dropped: a stream that has
    // started sending something else is worth knowing about, and not worth
    // ending a watch over, because a reconnect would only meet the same stream.
    io.logError(`lane:watch: skipping an unparseable frame: ${errorText(error)}`);
    return CONTINUE;
  }
  // `null` is not `undefined`, so an `=== undefined` guard reads straight
  // through it and the property read throws — and a frame of `data: null`
  // throws on the ENVELOPE, before any guard on the payload can run. A frame
  // carrying `null` where an object belongs is the same class of thing as one
  // with no payload at all: skipped. Throwing here instead would exit 2,
  // reporting a VALID command line as the operator's mistake when it was the
  // server that sent nonsense.
  const payload = asEnvelope(envelope).payload;
  if (payload === undefined || payload === null || payload.type === undefined) return CONTINUE;
  const type = payload.type;
  const properties = payload.properties;
  const owner = properties?.sessionID;

  if (owner !== session) {
    if (type === "session.error" && owner === undefined) {
      const error = properties?.error;
      io.log(
        `error (not attributed to any session) ${error?.name ?? "unknown"}: ` +
          `${error?.data?.message ?? "no message"}`,
      );
    }
    // `server.connected`, `server.heartbeat`, and every other session's events
    // land here — including the ones that must NOT reset the stall timer.
    return CONTINUE;
  }

  if (type === "session.idle") return { outcome: "idle", forSession: true };
  if (type === "session.error") {
    const error = properties?.error;
    io.log(`error ${error?.name ?? "unknown"}: ${error?.data?.message ?? "no message"}`);
    return { outcome: "error", forSession: true };
  }
  if (type === "session.compacted") {
    io.log("compacted");
    return { outcome: "continue", forSession: true };
  }
  if (type === "session.status") {
    const status = properties?.status;
    if (status?.type === "idle") return { outcome: "idle", forSession: true };
    if (status?.type === "retry") {
      const message = status.message ?? "";
      const line =
        `retry attempt=${status.attempt ?? "unknown"} ` +
        `next=${status.next ?? "unknown"}${message === "" ? "" : ` ${message}`}`;
      io.log(line);
    }
    return { outcome: "continue", forSession: true };
  }
  if (type === "message.part.updated") {
    const line = partLine(properties?.part, steps);
    if (line !== null) io.log(line);
    return { outcome: "continue", forSession: true };
  }
  return { outcome: "continue", forSession: true };
}

/**
 * One printed line per `message.part.updated` whose part type the row names,
 * or null for every other part type.
 *
 * `text`, `reasoning`, and the ~50/s `message.part.delta` all land on the null
 * arm, and are dropped BEFORE printing. That is the difference between a
 * readable log and fifty lines a second of prose.
 */
function partLine(part: MessagePart | undefined | null, steps: StepCounter): string | null {
  if (part === undefined || part === null) return null;
  if (part.type === "tool") {
    return `tool ${part.tool ?? "unknown"} ${part.state?.status ?? "unknown"}`;
  }
  if (part.type === "step-start") return steps.start();
  if (part.type === "step-finish") {
    return steps.finish(part.reason ?? "unknown", part.tokens, part.cost);
  }
  return null;
}

/**
 * Subscribes to `/global/event` and follows one session until it ends.
 *
 * The conclusions, and why each is a distinct exit code:
 *
 * - 0 — the session went idle, by `session.idle` or a `session.status` whose
 *   type is `idle`.
 * - 1 — the session errored, or the stream dropped through every reconnect.
 * - 3 — no event FOR THIS SESSION arrived within `--stall` seconds. Heartbeats
 *   and other sessions' events deliberately do not reset that timer: the server
 *   being alive says nothing about the lane. 3 means INVESTIGATE, which is a
 *   different operator action from "it failed" and the reason it is not 1.
 *
 * A dropped stream is re-subscribed, because a drop is usually a tunnel blip
 * and the lane is unaffected. Each reconnect is a FRESH subscription with no
 * `after` and no replay, so events during the gap are lost; if the session went
 * idle inside that gap this watch cannot see it and ends in 3, and `usage` is
 * what tells the rest. After MAX_RECONNECTS a stream that keeps dropping is a
 * failure rather than a blip.
 */
export async function follow(args: FollowArgs, io: FollowIo): Promise<number> {
  const stallMs = args.stallSecs * 1000;
  // Hoisted so step numbering is the LANE's, not one subscription's: a drop
  // in the middle of step 7 must not make the next `step-start` claim to be
  // step 1, or a lane that reconnects three times reads as three short lanes.
  const steps = new StepCounter();
  for (let attempt = 0; attempt <= MAX_RECONNECTS; attempt++) {
    if (attempt > 0) {
      io.logError(
        `lane:watch: re-subscribing to ${GLOBAL_EVENT_PATH} (${attempt} of ${MAX_RECONNECTS}) — ` +
          `this is a fresh subscription, so events since the drop are lost`,
      );
      await waitBeforeReconnect(io);
    }
    const outcome = await subscribe(args, io, stallMs, steps);
    if (outcome !== "dropped") return EXIT_FOR[outcome];
  }
  io.logError(
    `lane:watch: ${GLOBAL_EVENT_PATH} dropped ${MAX_RECONNECTS + 1} times — giving up (exit ` +
      `${EXIT_FAILED}). If the lane finished inside one of those gaps this watch cannot see it; ` +
      `run \`lane:watch usage\` for what it cost.`,
  );
  return EXIT_FAILED;
}

/**
 * One subscription. Returns `"dropped"` for a rejected fetch, a non-200, a
 * body-less response, or a reader that reached `done` — the four ways the
 * stream can end without the session having ended.
 */
async function subscribe(
  args: FollowArgs,
  io: FollowIo,
  stallMs: number,
  steps: StepCounter,
): Promise<Outcome> {
  // The lane's, not this subscription's: `follow` owns it so step numbering
  // survives a reconnect.
  const decoder = new TextDecoder();
  // The render layer, per subscription: a reattach gets a fresh previous line,
  // so the first line after a drop prints even if it repeats the last one
  // before the drop. The re-subscribe on stderr says a new subscription began;
  // a log whose first line is missing would contradict it.
  const renderer = new LineRenderer(io.log);
  const renderIo = { log: (text: string) => renderer.print(text), logError: io.logError };
  let concluded: Outcome | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let wakeConnect: (() => void) | null = null;

  // THE STALL IS A FLAG AND A WAKE, NOT A PROMISE.
  //
  // A long-lived `stalled` promise that every read races against is a reaction
  // leak: `Promise.race` attaches to each of its inputs on every call, so at
  // the ~50 frames a second this stream carries, a multi-hour lane retains
  // hundreds of thousands of reactions on a promise that settles at most once.
  // (Re-using one promise does not help — `race` is called per read either
  // way.) So nothing here is ever raced in the read loop: the timer sets a
  // flag and wakes whatever is currently blocked, and the loop checks the flag
  // the moment it unblocks.
  let stalled = false;
  let timer: unknown;
  const arm = (): void => {
    io.clearTimer(timer);
    stalled = false;
    timer = io.setTimer(() => {
      stalled = true;
      if (reader !== null) {
        // Cancelling resolves the PENDING read as `done: true`, which unblocks
        // the loop. The flag is checked before the `done` branch, so a
        // cancellation this timer caused is never mistaken for a drop.
        void reader.cancel();
        return;
      }
      // Still connecting: there is no reader to cancel, so the one-shot
      // deferred the get is raced against is what gets woken.
      const wake = wakeConnect;
      wakeConnect = null;
      wake?.();
    }, stallMs);
  };
  // Armed BEFORE the get. A connect that never resolves was previously not
  // covered by the timer at all, so a tunnel that accepted the TCP connection
  // and then said nothing left the watch waiting forever — and `runFollow`
  // never reached its `finally`, so the request was never even aborted.
  arm();

  const parser = new SseParser((data) => {
    if (concluded !== null) return;
    const result = handleFrame(data, args.session, steps, renderIo);
    if (result.outcome !== "continue") {
      concluded = result.outcome;
      return;
    }
    // Only an event for THIS session keeps the lane alive. A heartbeat or
    // another lane's tool call re-arms nothing, which is the whole point of
    // the stall: the server being up is not the lane being up.
    if (result.forSession) arm();
  });

  try {
    // The ONE race in this function. It exists for the connect phase only, and
    // the get's rejection is folded into its result rather than left to reject:
    // once the stall wins, `runFollow` aborts the controller, the real fetch
    // rejects with AbortError, and an unfolded promise would be an unhandled
    // rejection — which crashes Node, and fails the vitest run.
    const connect = new Promise<"stalled">((resolve) => {
      wakeConnect = () => {
        resolve("stalled");
      };
    });
    let response: Response;
    try {
      const opened = await Promise.race([
        io.get(GLOBAL_EVENT_PATH, io.signal).then(
          (value) => ({ kind: "opened" as const, value }),
          (error: unknown) => ({ kind: "failed" as const, error }),
        ),
        connect,
      ]);
      if (opened === "stalled") return reportStall(args, io);
      if (opened.kind === "failed") {
        io.logError(`lane:watch: the event stream could not be opened: ${errorText(opened.error)}`);
        return "dropped";
      }
      response = opened.value;
    } finally {
      wakeConnect = null;
    }
    if (response.status !== 200) {
      io.logError(`lane:watch: the event stream answered ${response.status}`);
      return "dropped";
    }
    if (response.body === null) {
      io.logError("lane:watch: the event stream carried no body");
      return "dropped";
    }
    try {
      reader = response.body.getReader();
    } catch (error) {
      // A body that cannot be locked is a subscription that cannot be read, so
      // it is a drop like any other — NOT a command-line error. Letting it
      // escape would report a valid command as a usage failure.
      io.logError(`lane:watch: the event stream could not be read: ${errorText(error)}`);
      return "dropped";
    }

    for (;;) {
      // No race here. The read's rejection is folded into its RESULT for the
      // same reason as the get's: the caller's abort must not surface as an
      // unhandled rejection after this loop has already answered.
      const read = await reader.read().then(
        (chunk) => ({ kind: "chunk" as const, chunk }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      );
      // The order of the four arms is load-bearing. `stalled` is checked
      // FIRST because the stall's own `cancel()` is what produces the `done`
      // below: checked second, a stall would be reported as a dropped stream
      // and re-subscribed forever.
      if (stalled) return reportStall(args, io);
      if (read.kind === "failed") {
        io.logError(`lane:watch: the event stream failed mid-read: ${errorText(read.error)}`);
        return "dropped";
      }
      if (read.chunk.done) {
        io.logError("lane:watch: the event stream ended (the reader is done)");
        return "dropped";
      }
      parser.push(decoder.decode(read.chunk.value, { stream: true }));
      // The conclusion is read HERE, after the chunk that carried it, and not
      // on the way into the next iteration. `/global/event` never closes, so
      // checking before the push means the watch has its answer and then waits
      // for a frame that may not come for ten seconds: a finished lane is
      // reported up to a heartbeat late, and with any `--stall` shorter than
      // that gap it is reported as a STALL — exit 3, "investigate" — for a
      // lane that completed perfectly. A conclusion that arrives and is then
      // ignored is a wrong exit code, which is worse than a slow one.
      if (concluded !== null) return concluded;
    }
  } finally {
    io.clearTimer(timer);
  }
}

/** The one sentence a stall gets, from either place it can be seen. */
function reportStall(args: FollowArgs, io: FollowIo): Outcome {
  io.logError(
    `lane:watch: no event for session ${args.session} in ${args.stallSecs}s — the ` +
      `server may well be alive, but this lane is not (exit ${EXIT_UNKNOWN}, investigate)`,
  );
  return "stalled";
}
