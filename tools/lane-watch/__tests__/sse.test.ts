import { describe, expect, test } from "vitest";
import { SseParser } from "../lib/sse.js";

/** Feeds the chunks in order and returns every frame they completed. */
function read(...chunks: readonly string[]): readonly string[] {
  const frames: string[] = [];
  const parser = new SseParser((data) => frames.push(data));
  for (const chunk of chunks) parser.push(chunk);
  return frames;
}

describe("SseParser", () => {
  test("emits one frame per blank-line terminator on the LF stream this server sends", async () => {
    // The live stream is LF-terminated. Nothing strips a terminator here, so a
    // parser that only handled CRLF would still work — and a fixture that only
    // sent CRLF would be testing a stream this server does not send.
    expect(read('data: {"a":1}\n\ndata: {"b":2}\n\n')).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("strips the CR from a CRLF terminator, which the format also permits", async () => {
    // CRLF is legal SSE and a proxy in front of the tunnel may produce it. A
    // parser that split on "\n" and forgot the "\r" leaves it on the end of
    // every value, and the value then fails JSON.parse on a frame that was
    // perfectly well formed.
    expect(read('data: {"a":1}\r\n\r\ndata: {"b":2}\r\n\r\n')).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("joins a multi-line data field with a newline, as one frame", () => {
    // One event whose JSON was wrapped is still ONE event; dropping the
    // continuation would truncate the payload into something unparseable.
    expect(read('data: {"a":\ndata: 1}\n\n')).toEqual(['{"a":\n1}']);
  });

  test("ignores a colon comment, and a blank line that closes no frame", () => {
    // A keep-alive is a comment; a stray blank line is not a frame and must not
    // emit an empty one.
    expect(read(": keep-alive\n\ndata: x\n\n")).toEqual(["x"]);
    expect(read("\n\ndata: x\n\n")).toEqual(["x"]);
  });

  test("tolerates id: and event: fields, and uses neither", () => {
    // This stream carries no id: lines and has no replay, so reading either
    // would be inventing a feature the endpoint does not have.
    expect(read("id: 42\nevent: ping\ndata: x\n\n")).toEqual(["x"]);
  });

  test("holds a frame split across a chunk boundary mid-line", () => {
    // Chunks arrive per read; a split inside a line is ordinary, and emitting
    // either half would be a truncated frame the caller cannot detect. The
    // split before the CR is the awkward one: the line is not yet terminated,
    // so the "\r" that ends it has not been seen either.
    expect(read('data: {"a"', ":1}\n\n")).toEqual(['{"a":1}']);
    expect(read("data: x\r", "\n\r\n")).toEqual(["x"]);
    expect(read("data: x\r", "\n")).toEqual([]);
  });

  test("strips exactly one space after the colon", () => {
    // "data:  x" is the value " x": the first space is framing, the second is
    // the value's own.
    expect(read("data:  x\n\n")).toEqual([" x"]);
    expect(read("data:x\n\n")).toEqual(["x"]);
  });

  test("reads a bare `data` line as an empty value, and a bare unknown field as nothing", () => {
    expect(read("data\n\n")).toEqual([""]);
    expect(read("retry\n\n")).toEqual([]);
    expect(read("data: a\ndata\n\n")).toEqual(["a\n"]);
  });

  test("emits nothing for a frame that has not been terminated", () => {
    // A frame is only a frame once its blank line has arrived. Emitting the
    // partial one would hand `follow` a truncated payload to JSON.parse.
    const frames: string[] = [];
    const parser = new SseParser((data) => frames.push(data));
    parser.push('data: {"a":1}\n');
    expect(frames).toEqual([]);
    parser.push("\n");
    expect(frames).toEqual(['{"a":1}']);
  });
});
