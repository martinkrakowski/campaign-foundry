import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream, watch as fsWatch, type FSWatcher } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collect,
  MAX_TAIL_KB,
  prFacts,
  readTail,
  realDeps,
  waveIdFromDirName,
  type CollectDeps,
  type TailHandle,
} from "./lib/collect.js";
import type { LaneObservation, WaveStatus } from "./lib/types.js";

const DEFAULT_PORT = 4317;
const DEFAULT_TAIL_KB = 16;
const DEFAULT_POLL_MS = 15_000;
const SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * D105: the port is configurable, but 3000 and 3001 are the operator's
 * `next dev` and API — the refusal lives here, in code, not in a document.
 */
export function resolvePort(env: { readonly PORT?: string }): number {
  const raw = env.PORT;
  if (raw === undefined) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid PORT: ${JSON.stringify(raw)}`);
  }
  if (port === 3000 || port === 3001) {
    throw new Error(`D105: refusing to bind port ${port} — reserved for the operator's dev servers`);
  }
  return port;
}

export type Route =
  | { readonly kind: "index" }
  | { readonly kind: "status" }
  | { readonly kind: "stream" }
  | { readonly kind: "tokens" }
  | {
      readonly kind: "log";
      readonly wave: string;
      readonly lane: string;
      readonly search: URLSearchParams;
    }
  | { readonly kind: "notFound" };

/**
 * The whole route table, as data so a test can enumerate it (D106: these are
 * the only routes, all GET, none mutating). Path segments are validated so a
 * crafted lane name cannot climb out of the wave log root.
 */
export function routeFor(
  method: string | undefined,
  url: string | undefined,
): Route | "methodNotAllowed" {
  if (method !== "GET") return "methodNotAllowed";
  let parsed: URL;
  try {
    parsed = new URL(url ?? "/", "http://127.0.0.1");
  } catch {
    return { kind: "notFound" };
  }
  const path = parsed.pathname;
  if (path === "/") return { kind: "index" };
  if (path === "/api/status") return { kind: "status" };
  if (path === "/api/stream") return { kind: "stream" };
  if (path === "/tokens.css") return { kind: "tokens" };
  const log = /^\/api\/log\/([^/]+)\/([^/]+)$/.exec(path);
  if (log !== null && SEGMENT.test(log[1]) && SEGMENT.test(log[2])) {
    return { kind: "log", wave: log[1], lane: log[2], search: parsed.searchParams };
  }
  return { kind: "notFound" };
}

export type WatchFn = (path: string, listener: () => void) => Pick<FSWatcher, "close">;

export interface StartOptions {
  readonly port: number;
  /** The wave log root (`/tmp` in production — bin.ts passes it). */
  readonly root: string;
  /** Collection is injected so tests never shell out to `gh`. */
  readonly collect?: (now: string) => Promise<WaveStatus>;
  /**
   * Process-facing deps for the default collector and for log tails.
   * Tests inject `gh` (and wrap `open`) here; `collect` still wins when set.
   */
  readonly deps?: CollectDeps;
  /** The slow poll that catches `gh`-only changes; `fs.watch` covers the rest. */
  readonly pollMs?: number;
  /** Overridable so tests can point at a missing page. */
  readonly indexHtmlPath?: string;
  /**
   * Overridable so tests can point at a missing or malformed tokens file,
   * and to make a silent fallback the mutation that this lane's tests catch.
   */
  readonly tokensCssPath?: string;
  /** Overridable so tests can wrap `fs.watch` without stubbing the whole module. */
  readonly watch?: WatchFn;
}

export interface ServerHandle {
  readonly server: Server;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

/**
 * The read-only status server: it starts nothing, kills nothing and merges
 * nothing (D106). SSE clients get one `status` event on connect and another
 * whenever the collected status actually changes.
 */
export async function startServer(options: StartOptions): Promise<ServerHandle> {
  const deps = options.deps ?? realDeps;
  const indexHtmlPath =
    options.indexHtmlPath ?? fileURLToPath(new URL("./public/index.html", import.meta.url));
  // Follow the same repo-relative resolution as index.html: from this module's
  // location (`tools/wave-status/server.ts`) the repo root is two levels up.
  const tokensCssPath =
    options.tokensCssPath ??
    fileURLToPath(new URL("../../apps/web/src/styles/tokens.css", import.meta.url));
  const watchPath = options.watch ?? ((path, listener) => fsWatch(path, listener));

  const clients = new Set<ServerResponse>();
  const watchers: Pick<FSWatcher, "close">[] = [];
  const watched = new Set<string>();
  let lastJson = "";
  let lastComparable: string | undefined;
  let refreshRunning = false;
  let refreshQueued = false;
  let queuedRefreshPr = false;
  let prCache: Readonly<Record<string, LaneObservation["pr"]>> = {};

  /**
   * Startup, the 15 s poll, and on-demand `/api/status` refresh PR facts.
   * A watcher-triggered refresh reuses `prCache` and re-reads local state only.
   */
  const collectNow = async (refreshPr: boolean): Promise<WaveStatus> => {
    const now = new Date().toISOString();
    if (options.collect !== undefined) return options.collect(now);
    if (refreshPr) {
      prCache = await prFacts(deps);
    }
    return collect(deps, options.root, now, prCache);
  };

  const refresh = async (refreshPr: boolean): Promise<void> => {
    try {
      const status = await collectNow(refreshPr);
      const json = JSON.stringify(status);
      // generatedAt changes on every collection; it is not a change.
      const comparable = JSON.stringify({ ...status, generatedAt: "" });
      if (comparable === lastComparable) return;
      lastComparable = comparable;
      lastJson = json;
      for (const client of clients) client.write(`event: status\ndata: ${json}\n\n`);
    } catch {
      // Collection is best-effort; keep serving the last good snapshot.
    }
  };

  /** Coalesce overlapping watch/poll ticks so a change during an in-flight collect is not dropped. */
  const requestRefresh = (refreshPr: boolean): void => {
    if (refreshRunning) {
      refreshQueued = true;
      queuedRefreshPr = queuedRefreshPr || refreshPr;
      return;
    }
    refreshRunning = true;
    void refresh(refreshPr).finally(() => {
      refreshRunning = false;
      if (refreshQueued) {
        refreshQueued = false;
        const nextPr = queuedRefreshPr;
        queuedRefreshPr = false;
        requestRefresh(nextPr);
      }
    });
  };

  const syncWatchers = async (): Promise<void> => {
    try {
      const names = await readdir(options.root);
      for (const name of names) {
        if (!name.startsWith("wave") || watched.has(name)) continue;
        watched.add(name);
        watchers.push(watchPath(join(options.root, name), () => requestRefresh(false)));
      }
    } catch {
      // No wave directories (yet); the poll picks them up.
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const route = routeFor(req.method, req.url);
    if (route === "methodNotAllowed") {
      res.writeHead(405, { allow: "GET" });
      res.end();
      return;
    }
    if (route.kind === "notFound") {
      res.writeHead(404);
      res.end();
      return;
    }
    if (route.kind === "index") {
      try {
        const html = await readFile(indexHtmlPath);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
      } catch {
        res.writeHead(500);
        res.end();
      }
      return;
    }
    if (route.kind === "tokens") {
      await serveTokens(res, tokensCssPath);
      return;
    }
    if (route.kind === "status") {
      try {
        const status = await collectNow(true);
        const json = JSON.stringify(status);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(json);
      } catch {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end("internal error");
      }
      return;
    }
    if (route.kind === "stream") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`event: status\ndata: ${lastJson}\n\n`);
      clients.add(res);
      res.on("close", () => clients.delete(res));
      return;
    }
    await serveLog(res, options.root, route.wave, route.lane, route.search, deps.open);
  };

  await refresh(true);
  await syncWatchers();
  const timer = setInterval(() => {
    requestRefresh(true);
    void syncWatchers();
  }, options.pollMs ?? DEFAULT_POLL_MS);
  timer.unref();

  const server = createServer((req, res) => void handle(req, res));
  try {
    await listen(server, options.port);
  } catch (error) {
    clearInterval(timer);
    for (const watcher of watchers) watcher.close();
    server.close();
    throw error;
  }
  const address = server.address() as { port: number };

  return {
    server,
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      clearInterval(timer);
      for (const watcher of watchers) watcher.close();
      for (const client of clients) client.end();
      clients.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

/** `/api/log/:wave/:lane` — tail of the lane log or a full export with `?full=1`. */
async function serveLog(
  res: ServerResponse,
  root: string,
  wave: string,
  lane: string,
  search: URLSearchParams,
  open: (path: string) => Promise<TailHandle>,
): Promise<void> {
  if (search.get("full") === "1") {
    const logPath = await resolveLogPath(root, wave, lane);
    if (logPath === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      const st = await stat(logPath);
      res.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-length": st.size,
        "content-disposition": `attachment; filename="${wave}-${lane}.log"`,
      });
      createReadStream(logPath).pipe(res);
    } catch {
      res.writeHead(404);
      res.end();
    }
    return;
  }

  const kb = tailKb(search.get("tail"));
  if (kb === undefined) {
    res.writeHead(400);
    res.end();
    return;
  }
  const logPath = await resolveLogPath(root, wave, lane);
  if (logPath === undefined) {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    const part = await readTail(open, logPath, kb * 1024);
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(part.tail);
  } catch {
    res.writeHead(404);
    res.end();
  }
}

/**
 * `/tokens.css` — the app's dark tokens, extracted from tokens.css and served
 * as CSS. This lane exists so the status page stops copying the values: it links
 * this route instead of redeclaring them, so a token change in the app cannot
 * silently drift. Fail loudly on a missing file or missing dark block — the
 * route 500s and names the file, and the page is visibly unstyled.
 */
async function serveTokens(res: ServerResponse, tokensCssPath: string): Promise<void> {
  let css: string;
  try {
    css = await readFile(tokensCssPath, "utf8");
  } catch {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(`tokens.css missing or unreadable: ${tokensCssPath}`);
    return;
  }
  const dark = extractDarkBlock(css);
  if (dark === undefined) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(`tokens.css has no dark block: ${tokensCssPath}`);
    return;
  }
  res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
  res.end(dark);
}

/**
 * Extract the top-level `.dark { … }` block from a CSS file. One traversal,
 * skipping comments and strings throughout: a `.dark` mentioned inside a
 * comment or a string cannot start the match — the real tokens.css names the
 * class in its header comment — and a brace inside either cannot cut it short.
 * The match is taken only in selector position, where the character after the
 * name cannot continue it, so `.darkish` is not `.dark`. The returned rule
 * carries its `.dark` selector — a faithful copy of the app's block, not a
 * headless `{ … }` body a browser would discard. Returns undefined when there
 * is no `.dark` block.
 */
export function extractDarkBlock(css: string): string | undefined {
  let start = -1;
  let depth = 0;
  let inComment = false;
  let inQuote: "'" | '"' | null = null;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (inComment) {
      if (ch === "*" && css[i + 1] === "/") {
        inComment = false;
        i++;
      }
      continue;
    }
    if (inQuote !== null) {
      if (ch === "\\") {
        i++;
      } else if (ch === inQuote) {
        inQuote = null;
      }
      continue;
    }
    if (ch === "/" && css[i + 1] === "*") {
      inComment = true;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inQuote = ch;
      continue;
    }
    if (start < 0 && depth === 0 && ch === "." && css.startsWith(".dark", i)) {
      const after = css[i + 5];
      if (after === undefined || !/[A-Za-z0-9_-]/.test(after)) start = i;
    }
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) return css.slice(start, i + 1);
    }
  }
  return undefined;
}

/** Map a wave id back to its log directory by re-deriving ids from the root. */
async function resolveLogPath(
  root: string,
  wave: string,
  lane: string,
): Promise<string | undefined> {
  let names: readonly string[];
  try {
    names = await readdir(root);
  } catch {
    return undefined;
  }
  const dir = names.find((name) => name.startsWith("wave") && waveIdFromDirName(name) === wave);
  return dir === undefined ? undefined : join(root, dir, `${lane}.log`);
}

function tailKb(raw: string | null): number | undefined {
  if (raw === null) return DEFAULT_TAIL_KB;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_TAIL_KB;
  if (parsed > MAX_TAIL_KB) return undefined;
  return parsed;
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}
