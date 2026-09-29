/** The two environment variables wave-event.sh's default resolution reads. */
export interface LogDirEnv {
  readonly HOME?: string;
  readonly WAVE_LOG_ROOT?: string;
}

/**
 * The default log directory for a wave id, exactly as wave-event.sh:7-8 and
 * :63-83 resolve it when no `--logdir`/`<logdir>` is given: `root` is
 * `$WAVE_LOG_ROOT`, or `$HOME/.waves` (`/tmp/.waves` when `$HOME` is unset —
 * `${HOME:-/tmp}/.waves`). Then, in order: `<root>/wave-<wave>`,
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
  const defaultRoot = `${env.HOME ?? "/tmp"}/.waves`;
  const root = env.WAVE_LOG_ROOT ?? defaultRoot;
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
