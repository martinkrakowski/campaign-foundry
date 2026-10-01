import type { FetchLike } from "../lib/server.js";
import type { SpawnResult } from "../lib/types.js";

/**
 * Fixture builders for the tests. Nothing here opens a socket, reads a real
 * file, or runs a process: the server is a `Response` over a `ReadableStream`
 * this file hands out chunk by chunk, and the wave event is an injected
 * `spawn`.
 *
 * The frame shapes come from the row's facts about opencode 1.18.33, read live
 * by a reviewer: a frame is `data: {directory, project, workspace, payload}`
 * with `payload = {id, type, properties}`, and the live stream is
 * **LF-terminated**. CRLF is still what the SSE format permits, so the parser
 * accepts both and there is a fixture for each — but the fixture that matches
 * this server is the LF one.
 */

const encoder = new TextEncoder();

/** One wrapped `data:` frame, in the endpoint's CRLF framing. */
export function frame(type: string, properties: Record<string, unknown>): string {
  return data({
    directory: "/repo",
    project: "campaignfoundry",
    workspace: "wt-hxf4",
    payload: { id: `msg_${type}`, type, properties },
  });
}

/** One UNWRAPPED `data:` frame — how the heartbeat and `server.connected` arrive. */
export function bare(body: unknown): string {
  return data(body);
}

/** The framing itself: `data: `, LF, and the blank line that ends the frame. */
export function data(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

/**
 * The same framing with CRLF terminators, which the SSE format permits and a
 * proxy in front of the tunnel may well produce.
 */
export function dataCrlf(value: unknown): string {
  return `data: ${JSON.stringify(value)}\r\n\r\n`;
}

/** A frame whose payload is not a JSON object at all. */
export function rawFrame(text: string, terminator = "\n"): string {
  return `data: ${text}${terminator.repeat(2)}`;
}

/** A stream this file hands bytes to, one `push` at a time. */
export interface Source {
  readonly stream: ReadableStream<Uint8Array>;
  push(text: string): void;
  /** Fails the pending read, which is a drop the watch must survive. */
  fail(reason: unknown): void;
  close(): void;
}

export function source(): Source {
  let control: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      control = controller;
    },
  });
  return {
    stream,
    push: (text) => {
      control?.enqueue(encoder.encode(text));
    },
    fail: (reason) => {
      control?.error(reason);
    },
    close: () => {
      // The stall now CANCELS the reader it is waiting on, which closes the
      // underlying controller. A test that closes afterwards — as the stall
      // tests do, so a dropped timer fails fast rather than timing out — is
      // closing a stream that is already closed, which is a double-close in a
      // test double, not a condition any test is asserting on.
      try {
        control?.close();
      } catch {
        // already closed by the stall's cancel()
      }
    },
  };
}

/** A stream that has already ended: every read on it is immediately `done`. */
export function closed(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

/** One recorded call to the injected `fetch`. */
export interface Recorded {
  readonly url: string;
  readonly pathname: string;
  readonly method: string;
  readonly redirect: string;
  readonly signal: AbortSignal;
}

/**
 * One entry per fetch call. A function builds a FRESH response each time,
 * which a `Response` cannot do: its body is read once, so a four-reconnect
 * test needs four subscriptions rather than one replayed.
 */
export type Answer =
  | Response
  | (() => Response)
  | { readonly reject: unknown }
  /**
   * A connect that never resolves on its own and REJECTS with an AbortError
   * when the caller's signal fires — what a real `fetch` does.
   *
   * This is the shape that proves the get's rejection is folded into a result.
   * A stub that merely never resolves leaves a pending promise that nothing
   * ever settles, which cannot distinguish a handled rejection from an ignored
   * one; this one fails as soon as `runFollow` aborts, so an unfolded promise
   * becomes an unhandled rejection and fails the run.
   */
  | { readonly hangUntilAbort: true };

export interface FetchStub {
  readonly fetch: FetchLike;
  readonly calls: Recorded[];
}

/**
 * A `fetch` stub answering from a queue of responses, one per call, and
 * recording every call. The LAST entry repeats, so a test does not have to pad
 * a queue it only needs to be long enough.
 */
export function fetchStub(answers: readonly Answer[]): FetchStub {
  const calls: Recorded[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      pathname: new URL(url).pathname,
      method: init.method,
      redirect: init.redirect,
      signal: init.signal,
    });
    const at = Math.min(calls.length - 1, answers.length - 1);
    const answer = answers[at];
    if (typeof answer === "object" && answer !== null && "reject" in answer) {
      // A stream can fail with anything the runtime hands back, so the reject
      // form is `unknown`: `lane-watch` has to report a non-Error too.
      throw answer.reject;
    }
    if (typeof answer === "object" && answer !== null && "hangUntilAbort" in answer) {
      return await new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const error = new Error("This operation was aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    }
    return typeof answer === "function" ? answer() : answer;
  };
  return { fetch: fetchImpl, calls };
}

/** A 200 whose body is one JSON object — the session read. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A 200 whose body is a stream — the event subscription. */
export function eventStream(body: ReadableStream<Uint8Array> | null, status = 200): Response {
  return new Response(body, { status });
}

/** One recorded call to the injected `spawn`. */
export interface SpawnCall {
  readonly command: string;
  readonly args: readonly string[];
}

export interface SpawnStub {
  readonly spawn: (command: string, args: readonly string[]) => Promise<SpawnResult>;
  readonly calls: SpawnCall[];
}

/** A `spawn` stub answering from a queue, repeating its last entry. */
export function spawnStub(answers: readonly (SpawnResult | Error)[]): SpawnStub {
  const calls: SpawnCall[] = [];
  const spawn = async (command: string, args: readonly string[]): Promise<SpawnResult> => {
    calls.push({ command, args });
    const at = Math.min(calls.length - 1, answers.length - 1);
    const answer = answers[at];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { spawn, calls };
}
