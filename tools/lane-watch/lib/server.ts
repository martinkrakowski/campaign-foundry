import { LANE_WATCH_USAGE } from "./usage-text.js";

/**
 * The `fetch` this tool calls, narrowed to what `get` is allowed to do with it.
 *
 * The literals are the point: `method` and `redirect` are typed as the only
 * values this tool ever sends, so the constraint is in the type and not only in
 * the one function that happens to obey it today. Injected rather than reached
 * for globally, so every test drives the tool through a stub and no test can
 * reach a real server by accident. The entry wrapper in `cli.ts` passes Node
 * 22's global `fetch`, and it is the only place in `tools/lane-watch/` that
 * mentions it.
 */
export type FetchLike = (
  url: string,
  init: { readonly method: "GET"; readonly redirect: "error"; readonly signal: AbortSignal },
) => Promise<Response>;

/**
 * The hosts `--server` may name: the ocm tunnel's own three spellings.
 *
 * `[::1]` is the LITERAL hostname `new URL()` produces for an IPv6 literal —
 * Node keeps the brackets — so the allowlist holds the bracketed form and
 * would not match a bare `::1`.
 */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The session id shape. Anchored, and the character class excludes `_` and `-`. */
export const SESSION_ID = /^ses_[A-Za-z0-9]+$/;

/**
 * The only two pathnames `get` will request, as one alternation: the session
 * read and the event stream. Nothing else is reachable — not a directory
 * query, not a config path, not a second session.
 */
export const ALLOWED_PATHS = /^\/(?:session\/ses_[A-Za-z0-9]+|global\/event)$/;

/** The event stream's path, named once so `follow` and the allowlist cannot drift. */
export const GLOBAL_EVENT_PATH = "/global/event";

/** The session read's path, built from an id `checkSession` already validated. */
export function sessionPath(session: string): string {
  return `/session/${session}`;
}

/**
 * Validates `--server` and returns its ORIGIN, not the string as typed.
 *
 * Two reasons that is not a formality. A typed path (`http://127.0.0.1:4096/x`)
 * is dropped rather than silently prefixed onto every request, and a typed
 * `user:pass@` is dropped with it. What reaches `get` is a bare
 * `scheme://host:port`, and the only path that ever follows is one this tool
 * built.
 *
 * The loopback check is the one that matters: `--server` is the ONLY thing
 * standing between a mistyped flag and a request to whatever host the operator
 * named. The tunnel is local by construction, so anything else is either a
 * mistake or an exfiltration, and both are exit 2.
 */
export function checkServer(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`--server is not a URL: '${raw}'\n${LANE_WATCH_USAGE}`);
  }
  if (url.protocol !== "http:") {
    throw new Error(`--server must be http://, got '${raw}'\n${LANE_WATCH_USAGE}`);
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      `--server must be the ocm tunnel (127.0.0.1, localhost or [::1]), got '${url.hostname}'\n` +
        `${LANE_WATCH_USAGE}`,
    );
  }
  return url.origin;
}

/** Validates `--session`, so a session id is never anything but `ses_…`. */
export function checkSession(raw: string): string {
  if (!SESSION_ID.test(raw)) {
    throw new Error(`--session must match ${SESSION_ID.source}, got '${raw}'\n${LANE_WATCH_USAGE}`);
  }
  return raw;
}

/** `get(path, signal)` — the one place this tool builds a request. */
export type Get = (path: string, signal: AbortSignal) => Promise<Response>;

/**
 * Builds the single `get` helper: the only `fetch` call site in the tool.
 *
 * Three properties are structural here rather than left to each caller, so a
 * future caller cannot forget one:
 *
 * - the method is GET and `redirect` is `"error"`, on every request. There is
 *   no code path in `lane:watch` that writes to a server, and a redirect is
 *   followed-or-refused rather than resolved, so a 302 cannot move a read to
 *   another host behind the loopback check;
 * - the path is matched against `ALLOWED_PATHS` before the URL is built, so an
 *   unlisted path is refused instead of requested;
 * - the base is an origin, so a `//host` path cannot re-point the request —
 *     which is why the check is on `path`, not only on the resolved pathname.
 */
export function makeGet(server: string, fetchImpl: FetchLike): Get {
  return async (path, signal) => {
    if (!ALLOWED_PATHS.test(path)) {
      throw new Error(`refusing to request '${path}': not one of the two paths lane:watch reads`);
    }
    return await fetchImpl(new URL(path, server).href, {
      method: "GET",
      redirect: "error",
      signal,
    });
  };
}
