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
  const payload = envelope.payload;
  if (payload === undefined || payload.type === undefined) return CONTINUE;
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
function partLine(part: MessagePart | undefined, steps: StepCounter): string | null {
  if (part === undefined) return null;
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
  for (let attempt = 0; attempt <= MAX_RECONNECTS; attempt++) {
    if (attempt > 0) {
      io.logError(
        `lane:watch: re-subscribing to ${GLOBAL_EVENT_PATH} (${attempt} of ${MAX_RECONNECTS}) — ` +
          `this is a fresh subscription, so events since the drop are lost`,
      );
    }
    const outcome = await subscribe(args, io, stallMs);
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
async function subscribe(args: FollowArgs, io: FollowIo, stallMs: number): Promise<Outcome> {
  let response: Response;
  try {
    response = await io.get(GLOBAL_EVENT_PATH, io.signal);
  } catch (error) {
    io.logError(`lane:watch: the event stream could not be opened: ${errorText(error)}`);
    return "dropped";
  }
  if (response.status !== 200) {
    io.logError(`lane:watch: the event stream answered ${response.status}`);
    return "dropped";
  }
  if (response.body === null) {
    io.logError("lane:watch: the event stream carried no body");
    return "dropped";
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch (error) {
    // A body that cannot be locked is a subscription that cannot be read, so
    // it is a drop like any other — NOT a command-line error. Letting it
    // escape would report a valid command as a usage failure.
    io.logError(`lane:watch: the event stream could not be read: ${errorText(error)}`);
    return "dropped";
  }
  const steps = new StepCounter();
  const decoder = new TextDecoder();
  let concluded: Outcome | null = null;

  // One promise for the whole subscription. It resolves at most once, and the
  // race below re-uses it every iteration, so re-arming the timer is a
  // clearTimeout + setTimeout and never a new promise.
  //
  // It resolves to the literal "stalled" and nothing else, which is why the
  // race below needs no second test on the outcome: winning that race IS the
  // stall, and a check for a value the promise cannot hold would be a branch
  // nothing could ever cover.
  let fireStall!: () => void;
  const stalled = new Promise<"stalled">((resolve) => {
    fireStall = () => {
      resolve("stalled");
    };
  });
  let timer: unknown;
  const arm = (): void => {
    io.clearTimer(timer);
    timer = io.setTimer(fireStall, stallMs);
  };
  arm();

  const parser = new SseParser((data) => {
    if (concluded !== null) return;
    const result = handleFrame(data, args.session, steps, io);
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
    for (;;) {
      // The read's rejection is folded into its RESULT rather than left to
      // reject: when the stall wins this race the read is still pending, and
      // the caller's abort then fails it. An unhandled rejection there would
      // be reported against a watch that already answered, which is noise
      // about a decision this code has already made.
      const read = reader.read().then(
        (chunk) => ({ kind: "chunk" as const, chunk }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      );
      const raced = await Promise.race([read, stalled.then(() => ({ kind: "stall" as const }))]);
      if (raced.kind === "stall") {
        io.logError(
          `lane:watch: no event for session ${args.session} in ${args.stallSecs}s — the ` +
            `server may well be alive, but this lane is not (exit ${EXIT_UNKNOWN}, investigate)`,
        );
        return "stalled";
      }
      if (raced.kind === "failed") {
        io.logError(`lane:watch: the event stream failed mid-read: ${errorText(raced.error)}`);
        return "dropped";
      }
      if (concluded !== null) return concluded;
      if (raced.chunk.done) {
        io.logError("lane:watch: the event stream ended (the reader is done)");
        return "dropped";
      }
      parser.push(decoder.decode(raced.chunk.value, { stream: true }));
    }
  } finally {
    io.clearTimer(timer);
  }
}
