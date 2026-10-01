/**
 * How `lane:watch` reports a failure, in one place.
 *
 * The four codes are the tool's whole contract with an operator, and the one
 * that matters most is 3: it is the only code that means NEITHER success nor
 * failure, but "the server stopped telling me" — which is the condition that
 * today is invisible and gets mistaken for a lane that is merely slow.
 */

/** The lane went idle, or the usage was read. */
export const EXIT_OK = 0;
/** The session is not there, the lane errored, or the stream dropped. */
export const EXIT_FAILED = 1;
/** The command line itself is wrong: a non-loopback server, a bad id, a bad flag. */
export const EXIT_USAGE = 2;
/** The server did not report something, or one session went quiet. Investigate. */
export const EXIT_UNKNOWN = 3;

/** The message of a thrown thing, whether or not it was thrown as an `Error`. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
