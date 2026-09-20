/**
 * The one place a network adapter's request deadline is composed (R5, D77/L13).
 *
 * Two deadlines, and they answer different questions. The **ceiling** bounds a
 * single request, so one hung socket cannot hold a campaign until the process
 * dies — which is the defect L5 names: the three image adapters contained no
 * timeout and no signal at all. The **run signal** cancels the campaign as a
 * whole, so once a run is abandoned the calls it has not made yet are never
 * made.
 *
 * Neither implies the other. A per-request ceiling alone still lets an
 * abandoned run keep spending on the cells it has left; a run signal alone
 * still lets one socket hang forever inside a live run.
 *
 * `AbortSignal.timeout` is the house pattern, copied from
 * `OpenRouterCopyGenerator`, which has had a 30 s ceiling all along — these
 * adapters simply never got one.
 *
 * Deliberately NOT applied to the ffmpeg compositor: it already carries its own
 * timeout, and a second one would race it (R5's own note).
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * The signal one upstream request should actually be made with: the run's, if
 * there is one, composed with this request's ceiling.
 *
 * Returned rather than applied so each adapter passes it to its own `fetch` —
 * Firefly makes three calls (token, generate, download) and each needs its own
 * ceiling, not one shared across all three.
 */
export function requestSignal(
  run: AbortSignal | undefined,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): AbortSignal {
  const ceiling = AbortSignal.timeout(timeoutMs);
  // `any` settles on whichever fires first and carries that reason, so an
  // aborted run and an expired ceiling stay distinguishable to a caller
  // inspecting `signal.reason`.
  return run === undefined ? ceiling : AbortSignal.any([run, ceiling]);
}
