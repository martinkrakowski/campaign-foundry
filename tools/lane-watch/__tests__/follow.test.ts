import { afterEach, describe, expect, test, vi } from "vitest";
import { runCli, type LaneWatchCliIo } from "../cli.js";
import { MAX_RECONNECTS } from "../lib/follow.js";
import { ALLOWED_PATHS } from "../lib/server.js";
import { bare, closed, eventStream, fetchStub, frame, source, type Source } from "./fixtures.js";

const SERVER = "http://127.0.0.1:4096";
const SESSION = "ses_ours";
const OTHER = "ses_theirs";

afterEach(() => {
  vi.useRealTimers();
});

interface Harness {
  readonly io: LaneWatchCliIo;
  readonly log: string[];
  readonly err: string[];
  readonly calls: {
    readonly pathname: string;
    readonly method: string;
    readonly redirect: string;
    readonly signal: AbortSignal;
  }[];
}

function harness(
  argv: readonly string[],
  answers: Parameters<typeof fetchStub>[0],
  timers: {
    readonly set: LaneWatchCliIo["setTimer"];
    readonly clear: LaneWatchCliIo["clearTimer"];
    /** 0 in every harness but the one that tests the reconnect backoff. */
    readonly reconnectDelayMs?: number;
  } = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    reconnectDelayMs: 0,
  },
): Harness {
  const log: string[] = [];
  const err: string[] = [];
  const stub = fetchStub(answers);
  return {
    log,
    err,
    calls: stub.calls,
    io: {
      argv,
      log: (text) => log.push(text),
      logError: (text) => err.push(text),
      fetch: stub.fetch,
      spawn: async () => ({ code: 0, stderr: "" }),
      setTimer: timers.set,
      clearTimer: timers.clear,
      reconnectDelayMs: timers.reconnectDelayMs ?? 0,
    },
  };
}

const followArgv = (extra: readonly string[] = []): readonly string[] => [
  "follow",
  "--server",
  SERVER,
  "--session",
  SESSION,
  ...extra,
];

/** An open subscription the test feeds, so nothing is decided by a timer. */
function open(): { readonly answer: () => Response; readonly feed: Source } {
  const s = source();
  return { answer: () => eventStream(s.stream), feed: s };
}

describe("lane:watch follow — the session filter", () => {
  test("another lane going idle does not end this lane's watch", async () => {
    // /global/event carries EVERY instance's events. Without the filter this
    // watch would end 0 on the other lane's idle and report a running lane
    // finished.
    const { answer, feed } = open();
    const h = harness(followArgv(), [answer]);
    const running = runCli(h.io);
    feed.push(frame("session.idle", { sessionID: OTHER }));
    feed.push(
      frame("message.part.updated", { sessionID: OTHER, part: { type: "tool", tool: "grep" } }),
    );
    feed.push(
      frame("message.part.updated", {
        sessionID: SESSION,
        part: { type: "tool", tool: "bash", state: { status: "running" } },
      }),
    );
    feed.push(frame("session.idle", { sessionID: SESSION }));
    feed.close();
    expect(await running).toBe(0);
    // The other lane's tool call is not in the log, and ours is: the filter
    // runs before printing, not after.
    expect(h.log).toEqual(["tool bash running"]);
  });

  test("heartbeats, connected frames and an unwrapped sync are dropped without printing", async () => {
    // `{"type":"sync"}` is the real UNWRAPPED frame this server sends: no
    // directory, no project, no payload — just a type at the top level. It is
    // the shape a reader who assumed the envelope would trip over, and it must
    // be skipped exactly like a heartbeat.
    const { answer, feed } = open();
    const h = harness(followArgv(), [answer]);
    const running = runCli(h.io);
    feed.push(bare({ type: "server.connected" }));
    feed.push(bare({ type: "sync" }));
    feed.push(bare({ type: "server.heartbeat", timestamp: 1 }));
    feed.push(bare({ type: "server.heartbeat", timestamp: 2 }));
    feed.push(frame("session.idle", { sessionID: SESSION }));
    feed.close();
    expect(await running).toBe(0);
    expect(h.log).toEqual([]);
  });

  test("a frame that is not JSON, or carries no payload, is dropped and named", async () => {
    const { answer, feed } = open();
    const h = harness(followArgv(), [answer]);
    const running = runCli(h.io);
    feed.push("data: {not json\r\n\r\n");
    feed.push(bare({ directory: "/repo" }));
    feed.push(bare([1, 2, 3]));
    feed.push(bare("a string, not an envelope"));
    feed.push(bare({ payload: { properties: { sessionID: SESSION } } }));
    feed.push(frame("session.idle", { sessionID: SESSION }));
    feed.close();
    expect(await running).toBe(0);
    expect(h.log).toEqual([]);
    expect(h.err.join("\n")).toContain("unparseable frame");
  });

  test("a null envelope, payload or part is skipped, not thrown", async () => {
    // `null` is not `undefined`, so an `=== undefined` guard reads straight
    // through it and the property read throws. A malformed frame is the same
    // class of thing as a frame with no payload: skipped, not fatal. Throwing
    // here exits 2, which reports a VALID command line as the operator's
    // mistake when it was the server that sent nonsense.
    const { answer, feed } = open();
    const h = harness(followArgv(), [answer]);
    const running = runCli(h.io);
    feed.push(bare(null));
    feed.push(bare({ payload: null }));
    feed.push(frame("message.part.updated", { sessionID: SESSION, part: null }));
    feed.push(frame("session.idle", { sessionID: SESSION }));
    feed.close();
    expect(await running).toBe(0);
    expect(h.log).toEqual([]);
  });
});

describe("lane:watch follow — the printed lines", () => {
  test("a tool, a step-start and a step-finish each print one line", async () => {
    const { answer, feed } = open();
    const h = harness(followArgv(), [answer]);
    const running = runCli(h.io);
    feed.push(
      frame("message.part.updated", {
        sessionID: SESSION,
        part: { type: "step-start" },
      }),
    );
    feed.push(
      frame("message.part.updated", {
        sessionID: SESSION,
        part: { type: "tool", tool: "bash", state: { status: "running" } },
      }),
    );
    feed.push(
      frame("message.part.updated", {
        sessionID: SESSION,
        part: { type: "tool", tool: "bash", state: { status: "completed" } },
      }),
    );
    feed.push(
      frame("message.part.updated", {
        sessionID: SESSION,
        part: { type: "step-finish", reason: "stop", tokens: 1234, cost: 0.02 },
      }),
    );
    feed.push(frame("session.idle", { sessionID: SESSION }));
    feed.close();
    expect(await running).toBe(0);
    expect(h.log).toEqual([
      "step 1 start",
      "tool bash running",
      "tool bash completed",
      "step 1 finish reason=stop tokens=1234 cost=0.02",
    ]);
  });

  test("message.part.delta is never printed, and neither is any other part type", async () => {
    // ~50 frames a second. Printing them is the difference between a readable
    // log and a wall of prose, so the drop happens before printing.
    const { answer, feed } = open();
    const h = harness(followArgv(), [answer]);
    const running = runCli(h.io);
    for (let i = 0; i < 50; i++) {
      feed.push(
        frame("message.part.delta", {
          sessionID: SESSION,
          part: { type: "text", text: `chunk ${i} of the model's answer` },
        }),
      );
    }
    feed.push(
      frame("message.part.updated", {
        sessionID: SESSION,
        part: { type: "text", text: "the whole thought" },
      }),
    );
    feed.push(
      frame("message.part.updated", {
        sessionID: SESSION,
        part: { type: "reasoning", text: "thinking" },
      }),
    );
    feed.push(frame("message.part.updated", { sessionID: SESSION }));
    feed.push(frame("message.updated", { sessionID: SESSION }));
    feed.push(frame("session.idle", { sessionID: SESSION }));
    feed.close();
    expect(await running).toBe(0);
    expect(h.log).toEqual([]);
  });

  test("a step-finish whose fields the server omitted says unknown, not zero", async () => {
    const { answer, feed } = open();
    const h = harness(followArgv(), [answer]);
    const running = runCli(h.io);
    // A step-finish with no step-start before it reports step 0, visibly,
    // rather than being silently renumbered to look like a first step.
    feed.push(frame("message.part.updated", { sessionID: SESSION, part: { type: "step-finish" } }));
    feed.push(
      frame("message.part.updated", {
        sessionID: SESSION,
        part: { type: "step-start" },
      }),
    );
    // The row names a step-finish's tokens field but not its structure, so it
    // is carried opaquely: an object prints as compact JSON rather than being
    // flattened into a shape this tool would then have to keep in step with.
    feed.push(
      frame("message.part.updated", {
        sessionID: SESSION,
        part: {
          type: "step-finish",
          reason: "stop",
          tokens: { input: 10, output: 20, cache: { read: 5, write: 1 } },
          cost: 0.5,
        },
      }),
    );
    feed.push(frame("session.idle", { sessionID: SESSION }));
    feed.close();
    expect(await running).toBe(0);
    expect(h.log).toEqual([
      "step 0 finish reason=unknown tokens=unknown cost=unknown",
      "step 1 start",
      'step 1 finish reason=stop tokens={"input":10,"output":20,"cache":{"read":5,"write":1}} cost=0.5',
    ]);
  });

  test("a frame after the one that ended the watch is not read", async () => {
    // One read can carry the idle frame AND a trailing one. The watch has its
    // answer by the time the trailing frame is parsed, and reading it would
    // print a tool line for a lane that had already finished.
    const { answer, feed } = open();
    const h = harness(followArgv(), [answer]);
    const running = runCli(h.io);
    feed.push(
      frame("session.idle", { sessionID: SESSION }) +
        frame("message.part.updated", {
          sessionID: SESSION,
          part: { type: "tool", tool: "bash", state: { status: "running" } },
        }) +
        frame("message.part.updated", { sessionID: SESSION, part: { type: "step-start" } }),
    );
    feed.close();
    expect(await running).toBe(0);
    expect(h.log).toEqual([]);
  });

  test("session.compacted and a retrying status are printed", async () => {
    const { answer, feed } = open();
    const h = harness(followArgv(), [answer]);
    const running = runCli(h.io);
    feed.push(frame("session.compacted", { sessionID: SESSION }));
    feed.push(
      frame("session.status", {
        sessionID: SESSION,
        status: {
          type: "retry",
          attempt: 2,
          message: "rate limited",
          next: "2026-09-30T12:00:05Z",
        },
      }),
    );
    // A retry the server reported with none of its fields still says so,
    // rather than printing a zero attempt or an empty next.
    feed.push(frame("session.status", { sessionID: SESSION, status: { type: "retry" } }));
    feed.push(frame("session.status", { sessionID: SESSION, status: { type: "busy" } }));
    feed.push(frame("session.idle", { sessionID: SESSION }));
    feed.close();
    expect(await running).toBe(0);
    expect(h.log).toEqual([
      "compacted",
      "retry attempt=2 next=2026-09-30T12:00:05Z rate limited",
      "retry attempt=unknown next=unknown",
    ]);
  });

  test("a tool part with no name and no state still prints a line", async () => {
    const { answer, feed } = open();
    const h = harness(followArgv(), [answer]);
    const running = runCli(h.io);
    feed.push(frame("message.part.updated", { sessionID: SESSION, part: { type: "tool" } }));
    feed.push(frame("session.idle", { sessionID: SESSION }));
    feed.close();
    expect(await running).toBe(0);
    expect(h.log).toEqual(["tool unknown unknown"]);
  });
});

describe("lane:watch follow — the exits", () => {
  test("session.idle exits 0", async () => {
    const { answer, feed } = open();
    const h = harness(followArgv(), [answer]);
    const running = runCli(h.io);
    feed.push(frame("session.idle", { sessionID: SESSION }));
    feed.close();
    expect(await running).toBe(0);
  });

  test("a session.status of type idle exits 0", async () => {
    const { answer, feed } = open();
    const h = harness(followArgv(), [answer]);
    const running = runCli(h.io);
    feed.push(frame("session.status", { sessionID: SESSION, status: { type: "idle" } }));
    feed.close();
    expect(await running).toBe(0);
  });

  test("a session error for this session exits 1, naming the error and its message", async () => {
    const { answer, feed } = open();
    const h = harness(followArgv(), [answer]);
    const running = runCli(h.io);
    feed.push(
      frame("session.error", {
        sessionID: SESSION,
        error: {
          name: "ProviderAuthError",
          data: { message: "no stored credential for the model" },
        },
      }),
    );
    feed.close();
    expect(await running).toBe(1);
    expect(h.log).toEqual(["error ProviderAuthError: no stored credential for the model"]);
  });

  test("a session error with no error payload still exits 1 and prints a line", async () => {
    const { answer, feed } = open();
    const h = harness(followArgv(), [answer]);
    const running = runCli(h.io);
    feed.push(frame("session.error", { sessionID: SESSION }));
    feed.close();
    expect(await running).toBe(1);
    expect(h.log).toEqual(["error unknown: no message"]);
  });

  test("an error with no sessionID is printed, not attributed, and does not end the watch", async () => {
    // The field is optional. A failure nobody can attribute is still a failure
    // the operator should see, but it is not THIS lane's, so it must not be
    // reported as this lane's end — and it must not stop the watch either.
    const { answer, feed } = open();
    const h = harness(followArgv(), [answer]);
    const running = runCli(h.io);
    feed.push(
      frame("session.error", {
        error: { name: "BusyError", data: { message: "database is locked" } },
      }),
    );
    feed.push(frame("session.idle", { sessionID: SESSION }));
    feed.close();
    expect(await running).toBe(0);
    expect(h.log).toEqual(["error (not attributed to any session) BusyError: database is locked"]);
  });

  test("an unattributed error with no error payload at all still prints a line", async () => {
    const { answer, feed } = open();
    const h = harness(followArgv(), [answer]);
    const running = runCli(h.io);
    feed.push(frame("session.error", {}));
    feed.push(frame("session.error", { sessionID: undefined, error: {} }));
    feed.push(frame("session.idle", { sessionID: SESSION }));
    feed.close();
    expect(await running).toBe(0);
    // Two frames, one line: the render layer collapses consecutive identical
    // lines, and these two describe the same fact. The shapes differ (no
    // `error` key at all, and an empty one) and both are still read.
    expect(h.log).toEqual(["error (not attributed to any session) unknown: no message"]);
  });
});

describe("lane:watch follow — the stall", () => {
  test("heartbeats and another session's events do NOT reset it, and it exits 3", async () => {
    // The server being alive says nothing about the lane. A stall timer reset
    // by a heartbeat would never fire, and the watch that exists to notice a
    // silent lane would be the one thing keeping a silent lane looking healthy.
    vi.useFakeTimers();
    const stallSecs = 90;
    const { answer, feed } = open();
    const h = harness(followArgv(["--stall", String(stallSecs)]), [answer]);
    const running = runCli(h.io);
    await vi.advanceTimersByTimeAsync(0);
    // At 89s, still inside the window: a heartbeat and another lane's event
    // arrive and must not push the deadline out.
    await vi.advanceTimersByTimeAsync((stallSecs - 1) * 1000);
    feed.push(bare({ type: "server.heartbeat", timestamp: 1 }));
    feed.push(
      frame("message.part.updated", {
        sessionID: OTHER,
        part: { type: "tool", tool: "grep", state: { status: "running" } },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    // Closed only after the window has passed. With the timer working the
    // watch has already answered 3 by the time this runs, so the close is
    // inert; with the stall timer gone it is what ends the watch, at 1 — so
    // the test fails on the exit code rather than on a 5s timeout.
    feed.close();
    expect(await running).toBe(3);
    expect(h.err.join("\n")).toContain(`no event for session ${SESSION} in ${stallSecs}s`);
    expect(h.err.join("\n")).toContain("investigate");
  });

  test("an event for THIS session does reset it", async () => {
    // The other half of the same rule, and the reason the timer is re-armed
    // from the frame handler rather than from every read: a lane that is
    // working is a lane that is alive.
    vi.useFakeTimers();
    const stallSecs = 90;
    const { answer, feed } = open();
    const h = harness(followArgv(["--stall", String(stallSecs)]), [answer]);
    const running = runCli(h.io);
    await vi.advanceTimersByTimeAsync((stallSecs - 1) * 1000);
    feed.push(
      frame("message.part.updated", {
        sessionID: SESSION,
        part: { type: "tool", tool: "bash", state: { status: "running" } },
      }),
    );
    // Two seconds past the original deadline: past the old one, inside the
    // window the frame just opened.
    await vi.advanceTimersByTimeAsync(2000);
    feed.push(frame("session.idle", { sessionID: SESSION }));
    await vi.advanceTimersByTimeAsync(0);
    feed.close();
    expect(await running).toBe(0);
    expect(h.log).toEqual(["tool bash running"]);
  });

  test("the default stall is 600 seconds", async () => {
    vi.useFakeTimers();
    const { answer, feed } = open();
    const h = harness(followArgv(), [answer]);
    const running = runCli(h.io);
    await vi.advanceTimersByTimeAsync(599_000);
    feed.push(
      frame("message.part.updated", {
        sessionID: SESSION,
        part: { type: "tool", tool: "bash", state: { status: "running" } },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    feed.push(frame("session.idle", { sessionID: SESSION }));
    await vi.advanceTimersByTimeAsync(0);
    feed.close();
    expect(await running).toBe(0);
    expect(h.err.join("\n")).not.toContain("no event for session");
  });
});

describe("lane:watch follow — the concluding frame ends the watch itself", () => {
  /**
   * Each of these leaves the stream OPEN, which is the whole point.
   *
   * `/global/event` never closes, so a watch that waits for another frame
   * before acting on the one it has is waiting for a heartbeat: with the
   * default stall it reports a finished lane up to ten seconds late, and with
   * any stall shorter than the heartbeat gap it reports the finish as a
   * STALL — exit 3, "investigate" — for a lane that completed perfectly.
   */
  const concluding: readonly (readonly [string, () => string, number])[] = [
    ["session.idle", () => frame("session.idle", { sessionID: SESSION }), 0],
    [
      "a session.status of type idle",
      () => frame("session.status", { sessionID: SESSION, status: { type: "idle" } }),
      0,
    ],
    [
      "a session error",
      () =>
        frame("session.error", {
          sessionID: SESSION,
          error: { name: "ProviderAuthError", data: { message: "no credential" } },
        }),
      1,
    ],
  ];

  for (const [what, feed1, expected] of concluding) {
    test(`${what} ends the watch without waiting for another frame`, async () => {
      vi.useFakeTimers();
      const { answer, feed } = open();
      const h = harness(followArgv(["--stall", "2"]), [answer]);
      const running = runCli(h.io);
      feed.push(feed1());
      // Past the stall window, with the stream still open and nothing to
      // re-arm the timer. A watch that was still waiting here would end 3 —
      // which is why this advances BEFORE awaiting: the fixed watch has
      // already answered, and the broken one answers 3 during the same
      // advance, so the failure is the exit code and not a test timeout.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await running, what).toBe(expected);
      expect(h.err.join("\n"), what).not.toContain("no event for session");
    });
  }
  test("ten identical tool updates print one line, and each still re-arms the stall", async () => {
    // The collapse is at the render layer ONLY. Each of the ten is a live ping
    // from the lane, so the stall must still be re-armed by the last one: a
    // watch that printed one line and stopped counting would report a lane
    // that is running one long command as stalled.
    vi.useFakeTimers();
    const stallSecs = 30;
    const { answer, feed } = open();
    const h = harness(followArgv(["--stall", String(stallSecs)]), [answer]);
    const running = runCli(h.io);
    const tool = () =>
      frame("message.part.updated", {
        sessionID: SESSION,
        part: { type: "tool", tool: "bash", state: { status: "running" } },
      });
    for (let i = 0; i < 9; i++) {
      feed.push(tool());
      await vi.advanceTimersByTimeAsync(2000);
    }
    // 18s in, inside the 30s window: nine identical updates, one line.
    expect(h.log).toEqual(["tool bash running"]);
    feed.push(tool());
    // The tenth arrived at 18s, so the deadline moved to 48s. Advancing to
    // 36s is past the ORIGINAL deadline and well inside the current one.
    await vi.advanceTimersByTimeAsync(18_000);
    feed.push(frame("session.idle", { sessionID: SESSION }));
    await vi.advanceTimersByTimeAsync(0);
    feed.close();
    expect(await running).toBe(0);
    expect(h.log).toEqual(["tool bash running"]);
    expect(h.err.join("\n")).not.toContain("no event for session");
  });
});

describe("lane:watch follow — the drop", () => {
  test("a reader that reaches done exits 1 after 3 reconnects, over 4 fetches", async () => {
    // A dropped stream is usually a tunnel blip, so it is re-subscribed. Each
    // reconnect is a FRESH subscription with no `after` and no replay. The
    // answer is a factory because a Response's body can only be read once —
    // four fetches need four subscriptions.
    const h = harness(followArgv(), [() => eventStream(closed())]);
    expect(await runCli(h.io)).toBe(1);
    expect(h.calls).toHaveLength(MAX_RECONNECTS + 1);
    expect(h.calls).toHaveLength(4);
    for (const call of h.calls) expect(call.pathname).toBe("/global/event");
    expect(h.err.filter((line) => line.includes("re-subscribing"))).toHaveLength(MAX_RECONNECTS);
    expect(h.err.join("\n")).toContain("dropped 4 times");
    expect(h.err.join("\n")).toContain("lane:watch usage");
  });

  test("a rejected fetch is a drop, whether it was rejected as an Error or a string", async () => {
    const asError = harness(followArgv(), [{ reject: new Error("ECONNRESET") }]);
    expect(await runCli(asError.io)).toBe(1);
    expect(asError.calls).toHaveLength(4);
    for (const call of asError.calls) expect(call.pathname).toBe("/global/event");
    expect(asError.err.join("\n")).toContain("ECONNRESET");

    // A stream can fail with anything the runtime hands back, so a non-Error
    // rejection must still be reported rather than printing "undefined".
    const asString = harness(followArgv(), [{ reject: "the tunnel went away" }]);
    expect(await runCli(asString.io)).toBe(1);
    expect(asString.err.join("\n")).toContain("the tunnel went away");
  });

  test("a non-200 is a drop", async () => {
    const h = harness(followArgv(), [() => eventStream(closed(), 503)]);
    expect(await runCli(h.io)).toBe(1);
    expect(h.calls).toHaveLength(4);
    expect(h.err.join("\n")).toContain("answered 503");
  });

  test("a 200 with no body is a drop", async () => {
    const h = harness(followArgv(), [() => eventStream(null)]);
    expect(await runCli(h.io)).toBe(1);
    expect(h.err.join("\n")).toContain("carried no body");
  });

  test("a 200 whose body cannot be locked is a drop, not a usage error", async () => {
    // The body has already been read. A subscription this tool cannot read is
    // the same class of problem as one that dropped — exit 2 here would report
    // a valid command line as the operator's mistake.
    const once = eventStream(closed());
    await once.text();
    const h = harness(followArgv(), [once]);
    expect(await runCli(h.io)).toBe(1);
    expect(h.err.join("\n")).toContain("could not be read");
  });

  test("a stream that fails mid-read is a drop", async () => {
    const { answer, feed } = open();
    const h = harness(followArgv(), [answer]);
    const running = runCli(h.io);
    feed.fail(new Error("the tunnel went away"));
    expect(await running).toBe(1);
    expect(h.err.join("\n")).toContain("failed mid-read");
  });

  test("a non-zero reconnect delay is waited out between attempts, through the injected timer", async () => {
    // A short tunnel blip should not spend all four attempts inside one
    // heartbeat. The delay is read off the injected io and waited on the
    // injected setTimer, so it is the same clock the stall uses — which is
    // what lets a test observe it at all.
    vi.useFakeTimers();
    const h = harness(followArgv(), [() => eventStream(closed())], {
      set: (fn, ms) => setTimeout(fn, ms),
      clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      reconnectDelayMs: 2000,
    });
    const running = runCli(h.io);
    // Attempt 1 has been made and dropped; the watch is now waiting.
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(h.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.calls).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(0);
    expect(await running).toBe(1);
  });

  test("step numbering survives a reconnect, because the lane did not restart", async () => {
    const first = open();
    const second = open();
    const h = harness(followArgv(), [first.answer, second.answer]);
    const running = runCli(h.io);
    first.feed.push(
      frame("message.part.updated", { sessionID: SESSION, part: { type: "step-start" } }),
    );
    first.feed.close();
    second.feed.push(
      frame("message.part.updated", { sessionID: SESSION, part: { type: "step-start" } }),
    );
    second.feed.push(frame("session.idle", { sessionID: SESSION }));
    second.feed.close();
    expect(await running).toBe(0);
    // The counter belongs to the LANE. Held per subscription, the second step
    // would print as step 1 and a lane that dropped mid-way would read as two
    // short lanes rather than one longer one.
    expect(h.log).toEqual(["step 1 start", "step 2 start"]);
  });

  test("a reconnected stream that then reports idle exits 0", async () => {
    const first = open();
    const second = open();
    const h = harness(followArgv(), [first.answer, second.answer]);
    const running = runCli(h.io);
    // The chunks buffer in the second stream until the re-subscription reads
    // them, so these are delivered in order whatever the reconnects do.
    first.feed.close();
    second.feed.push(
      frame("message.part.updated", {
        sessionID: SESSION,
        part: { type: "tool", tool: "bash", state: { status: "running" } },
      }),
    );
    second.feed.push(frame("session.idle", { sessionID: SESSION }));
    second.feed.close();
    expect(await running).toBe(0);
    expect(h.calls).toHaveLength(2);
    expect(h.log).toEqual(["tool bash running"]);
  });
});

describe("lane:watch follow — the request and the abort", () => {
  test("every request is a GET, refuses redirects, and names an allowlisted path", async () => {
    const { answer, feed } = open();
    const h = harness(followArgv(), [answer]);
    const running = runCli(h.io);
    feed.push(frame("session.idle", { sessionID: SESSION }));
    feed.close();
    expect(await running).toBe(0);
    expect(h.calls.length).toBeGreaterThan(0);
    for (const call of h.calls) {
      expect(call.method).toBe("GET");
      expect(call.redirect).toBe("error");
      expect(ALLOWED_PATHS.test(call.pathname)).toBe(true);
      expect(call.pathname).toBe("/global/event");
    }
  });

  test("after a lane goes idle, the request has been aborted", async () => {
    // A watch that returns while its subscription is still open leaves a
    // socket and a server-side subscription running for a process that has
    // already answered. On a tunnel that is a leak per invocation.
    const { answer, feed } = open();
    const h = harness(followArgv(), [answer]);
    const running = runCli(h.io);
    feed.push(frame("session.idle", { sessionID: SESSION }));
    feed.close();
    expect(await running).toBe(0);
    expect(h.calls.every((call) => call.signal.aborted)).toBe(true);
  });

  test("after a lane errors, the request has been aborted", async () => {
    const { answer, feed } = open();
    const h = harness(followArgv(), [answer]);
    const running = runCli(h.io);
    feed.push(frame("session.error", { sessionID: SESSION, error: { name: "E" } }));
    feed.close();
    expect(await running).toBe(1);
    expect(h.calls.every((call) => call.signal.aborted)).toBe(true);
  });

  test("after a dropped stream is given up on, every request has been aborted", async () => {
    const h = harness(followArgv(), [() => eventStream(closed())]);
    expect(await runCli(h.io)).toBe(1);
    expect(h.calls).toHaveLength(4);
    expect(h.calls.every((call) => call.signal.aborted)).toBe(true);
  });

  test("after the stall fires, the request has been aborted", async () => {
    vi.useFakeTimers();
    const { answer, feed } = open();
    const h = harness(followArgv(["--stall", "1"]), [answer]);
    const running = runCli(h.io);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await running).toBe(3);
    expect(h.calls.every((call) => call.signal.aborted)).toBe(true);
    void feed;
  });

  test("a non-loopback server and a bad session id are both 2, before any request", async () => {
    const remote = harness(
      ["follow", "--server", "http://example.com:4096", "--session", SESSION],
      [eventStream(closed())],
    );
    expect(await runCli(remote.io)).toBe(2);
    expect(remote.calls).toEqual([]);

    const bad = harness(
      ["follow", "--server", SERVER, "--session", "nope"],
      [eventStream(closed())],
    );
    expect(await runCli(bad.io)).toBe(2);
    expect(bad.calls).toEqual([]);
  });
});

describe("lane:watch — the entry point", () => {
  test("no arguments is 2 with a usage line, and contacts nothing", async () => {
    const h = harness([], [eventStream(closed())]);
    expect(await runCli(h.io)).toBe(2);
    expect(h.err.join("\n")).toContain("usage: lane:watch usage");
    expect(h.calls).toEqual([]);
    expect(h.err.join("\n")).not.toContain("undefined");
  });

  test("an unknown command is 2, and names the command", async () => {
    const h = harness(["watch"], [eventStream(closed())]);
    expect(await runCli(h.io)).toBe(2);
    expect(h.err.join("\n")).toContain("'watch' is not a command");
    expect(h.calls).toEqual([]);
  });
});
