/**
 * A hand-rolled SSE reader. No dependency: the row requires Node 22's `fetch`
 * and nothing else, and the whole of the EventSource format this endpoint uses
 * is a few lines of `field: value` bookkeeping.
 *
 * What the row requires of the parser, and why each is here:
 *
 * - `data:` lines join with `\n` within one frame. A frame's JSON is one line
 *   in practice, but a server that wraps it is still sending ONE event, and
 *   joining is what makes it parse rather than truncate.
 * - A blank line terminates a frame. Nothing is emitted without one, so a
 *   partial frame at the end of a chunk is held, not guessed at.
 * - `:` comments are ignored. The endpoint sends keep-alives.
 * - `id:` and `event:` are tolerated and unused. This stream has no `id:`
 *   lines and no replay, so reading either would be inventing a feature.
 * - CRLF is accepted. The endpoint's terminator is CRLF, and a parser that
 *   only splits on `\n` leaves a `\r` on the end of every value, which then
 *   fails `JSON.parse` on a frame that was perfectly well formed.
 * - A chunk boundary may fall mid-line. Chunks arrive per read, and a split
 *   across a line's middle is ordinary, not an error.
 */
export class SseParser {
  private buffer = "";
  private readonly data: string[] = [];
  private readonly onFrame: (data: string) => void;

  constructor(onFrame: (data: string) => void) {
    this.onFrame = onFrame;
  }

  /** Feeds one decoded chunk, emitting every frame it completed. */
  push(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const at = this.buffer.indexOf("\n");
      if (at < 0) return;
      const line = this.buffer.slice(0, at).replace(/\r$/, "");
      this.buffer = this.buffer.slice(at + 1);
      this.line(line);
    }
  }

  /**
   * Handles one complete line, with its terminator already stripped.
   *
   * A field with no colon is a field with an empty value, per the format. A
   * line naming no field this reader uses is ignored rather than treated as
   * data, so a future `retry:` cannot be mistaken for one.
   */
  private line(line: string): void {
    if (line === "") {
      if (this.data.length > 0) {
        this.onFrame(this.data.join("\n"));
        this.data.length = 0;
      }
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    // A line with no colon names a field with an empty value, so `data` alone
    // is a data line carrying "" — not a line to drop.
    if ((colon < 0 ? line : line.slice(0, colon)) !== "data") return;
    // ONE leading space after the colon is framing, not value: `data:  x` is
    // the value " x".
    const value = colon < 0 ? "" : line.slice(colon + 1);
    this.data.push(value.startsWith(" ") ? value.slice(1) : value);
  }
}
