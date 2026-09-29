/** The environment variables wave-event.sh's own resolution reads, in the order it reads them. */
export interface LogDirEnv {
  readonly LOGDIR?: string;
  readonly HOME?: string;
  readonly WAVE_LOG_ROOT?: string;
}

/**
 * The default log directory for a wave id, exactly as wave-event.sh
 * resolves it when no `--logdir` flag is given.
 *
 * wave-event.sh:41 reads `$LOGDIR` FIRST (`LOGDIR="${LOGDIR:-}"`) — before
 * any of the candidate search below — and wave-event.sh:63 only runs that
 * search `if [ -z "$LOGDIR" ]`. So a caller's `$LOGDIR` (an operator's
 * standing override, or a wrapper script's own) must win outright here too,
 * with no `exists` check at all: an env var that is set and non-empty names
 * the directory, full stop.
 *
 * Only once `$LOGDIR` is unset or empty does the search run: `root` is
 * `$WAVE_LOG_ROOT`, or `$HOME/.waves` (`/tmp/.waves` when `$HOME` is unset —
 * `${HOME:-/tmp}/.waves`). Both checks are POSIX `${VAR:-word}` semantics —
 * unset OR EMPTY substitutes the fallback, not `??`'s unset-or-null-only
 * rule — so an exported `HOME=""` or `WAVE_LOG_ROOT=""` falls back exactly
 * as wave-event.sh does, rather than routing the gate at `//.waves/...` or
 * a directory the event writer never used. Then, in order: `<root>/wave-<wave>`,
 * `<root>/wave<wave>`, `<root>/<wave>` (only when `wave` already starts with
 * `wave`), then the same three under `/tmp` — the FIRST that exists wins.
 * When none exists, the default is `<root>/<wave>` when `wave` starts with
 * `wave`, otherwise `<root>/wave-<wave>` — `/tmp` is only ever a fallback for
 * a directory that is already there, never a default of its own.
 *
 * `merge-prs.sh` and `pre-pr-check` must agree with `wave-event.sh` bit for
 * bit — the very directory a lane's events were appended to — so this is a
 * literal port, not a reimplementation from the comment.
 */
export function defaultLogDir(
  wave: string,
  env: LogDirEnv,
  exists: (path: string) => boolean,
): string {
  if (env.LOGDIR !== undefined && env.LOGDIR !== "") {
    return env.LOGDIR;
  }

  // `??` alone triggers only on unset (null/undefined); POSIX `${VAR:-word}`
  // triggers on unset OR empty. An exported HOME="" or WAVE_LOG_ROOT="" must
  // fall back the same way, or the gate looks in a different directory from
  // the one wave-event.sh actually wrote to.
  const home = env.HOME !== undefined && env.HOME !== "" ? env.HOME : "/tmp";
  const defaultRoot = `${home}/.waves`;
  const root =
    env.WAVE_LOG_ROOT !== undefined && env.WAVE_LOG_ROOT !== "" ? env.WAVE_LOG_ROOT : defaultRoot;
  const startsWithWave = wave.startsWith("wave");

  const candidates = [
    `${root}/wave-${wave}`,
    `${root}/wave${wave}`,
    ...(startsWithWave ? [`${root}/${wave}`] : []),
    `/tmp/wave-${wave}`,
    `/tmp/wave${wave}`,
    ...(startsWithWave ? [`/tmp/${wave}`] : []),
  ];

  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }

  return startsWithWave ? `${root}/${wave}` : `${root}/wave-${wave}`;
}
