import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { watch as fsWatch, type FSWatcher } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { collect, realDeps, waveIdFromDirName } from "./lib/collect.js";
import type { WaveStatus } from "./lib/types.js";

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
  /** The slow poll that catches `gh`-only changes; `fs.watch` covers the rest. */
  readonly pollMs?: number;
  /** Overridable so tests can point at a missing page. */
  readonly indexHtmlPath?: string;
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
  const collectStatus = options.collect ?? ((now: string) => collect(realDeps, options.root, now));
  const indexHtmlPath =
    options.indexHtmlPath ?? fileURLToPath(new URL("./public/index.html", import.meta.url));
  const watchPath = options.watch ?? ((path, listener) => fsWatch(path, listener));

  const clients = new Set<ServerResponse>();
  const watchers: Pick<FSWatcher, "close">[] = [];
  const watched = new Set<string>();
  let lastJson = "";
  let lastComparable: string | undefined;
  let refreshRunning = false;
  let refreshQueued = false;

  const refresh = async (): Promise<void> => {
    try {
      const status = await collectStatus(new Date().toISOString());
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
  const requestRefresh = (): void => {
    if (refreshRunning) {
      refreshQueued = true;
      return;
    }
    refreshRunning = true;
    void refresh().finally(() => {
      refreshRunning = false;
      if (refreshQueued) {
        refreshQueued = false;
        requestRefresh();
      }
    });
  };

  const syncWatchers = async (): Promise<void> => {
    try {
      const names = await readdir(options.root);
      for (const name of names) {
        if (!name.startsWith("wave") || watched.has(name)) continue;
        watched.add(name);
        watchers.push(watchPath(join(options.root, name), requestRefresh));
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
    if (route.kind === "status") {
      const status = await collectStatus(new Date().toISOString());
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(status));
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
    await serveLog(res, options.root, route.wave, route.lane, route.search);
  };

  await refresh();
  await syncWatchers();
  const timer = setInterval(() => {
    requestRefresh();
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

/** `/api/log/:wave/:lane?tail=N` — the last N KB of the lane log, text/plain. */
async function serveLog(
  res: ServerResponse,
  root: string,
  wave: string,
  lane: string,
  search: URLSearchParams,
): Promise<void> {
  const logPath = await resolveLogPath(root, wave, lane);
  if (logPath === undefined) {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    const buf = await readFile(logPath);
    const bytes = tailKb(search.get("tail")) * 1024;
    const sliced = buf.length > bytes ? buf.subarray(buf.length - bytes) : buf;
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(sliced);
  } catch {
    res.writeHead(404);
    res.end();
  }
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

function tailKb(raw: string | null): number {
  if (raw === null) return DEFAULT_TAIL_KB;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_TAIL_KB;
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
