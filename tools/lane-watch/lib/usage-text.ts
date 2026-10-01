/**
 * The usage block, in one place so the no-argument path, a bad flag, and a
 * rejected `--server` all name the same two command lines.
 *
 * It is deliberately the SHORT form. The exit codes are the part an operator
 * has to act on, and they are not guessable from a flag list:
 *
 *   0  the lane went idle (follow), or the usage was read (usage)
 *   1  the session is not there, the lane errored, or the stream dropped
 *   2  the command line itself is wrong — a non-loopback `--server`, a session
 *      id that is not `ses_…`, an unknown flag, or a stage `wave-event.sh`
 *      refused when `--emit` ran
 *   3  the server did not report something (`usage`), or one session went
 *      quiet for `--stall` seconds (`follow`). Both mean INVESTIGATE.
 */
export const LANE_WATCH_USAGE =
  "usage: lane:watch usage --server <url> --session <id> [--json] " +
  "[--emit <logdir> <wave> <lane> <stage> [--event settled|failed]]\n" +
  "       lane:watch follow --server <url> --session <id> [--stall <secs>]\n" +
  "exit: 0 idle/read, 1 not found / errored / dropped, 2 bad command line, " +
  "3 unreported or stalled (investigate)";
