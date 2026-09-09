import { afterEach, describe, test, expect, vi, type Mock } from "vitest";

// The default-collection test exercises the realDeps wiring, but its `gh` and
// `pgrep` calls are stubbed at the execFile boundary (they are exercised for
// real in collect.test.ts) so the suite never waits on the network.
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
import { execFile } from "node:child_process";

import { watch as fsWatch } from "node:fs";
import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePort, routeFor, startServer, type ServerHandle } from "../server.js";
import { realDeps } from "../lib/collect.js";
import type { WaveStatus } from "../lib/types.js";

type ExecCallback = (error: Error | null, stdout: string) => void;
(execFile as unknown as Mock).mockImplementation(
  (
    file: string,
    _args: readonly string[],
    optionsOrCallback: ExecCallback | Record<string, unknown>,
    maybeCallback?: ExecCallback,
  ) => {
    const callback = (
      typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback
    ) as ExecCallback;
    queueMicrotask(() => callback(null, file === "gh" ? "[]" : ""));
    return undefined;
  },
);

const handles: ServerHandle[] = [];
const roots: string[] = [];

afterEach(async () => {
  while (handles.length > 0) {
    await handles.pop()?.close();
  }
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

async function start(options: Parameters<typeof startServer>[0]): Promise<ServerHandle> {
  const handle = await startServer(options);
  handles.push(handle);
  return handle;
}

/** A fixture wave-log root: waveT with a >1 KB log, waveU with a small one. */
async function makeFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "wave-status-server-"));
  roots.push(root);
  await mkdir(join(root, "waveT"));
  await mkdir(join(root, "waveU"));
  await mkdir(join(root, "notwave"));
  await writeFile(join(root, "loose.txt"), "not a wave dir\n");
  await writeFile(join(root, "waveT", "t1.log"), `${"x".repeat(3000)}\nEXIT 0\n`);
  await writeFile(join(root, "waveT", "gate-t1.log"), "GATE EXIT 0\n");
  await writeFile(
    join(root, "waveT", "events.jsonl"),
    `${JSON.stringify({
      ts: "2026-09-07T17:00:00Z",
      wave: "T",
      lane: "t1",
      stage: "gate",
      event: "started",
    })}\n`,
  );
  await writeFile(join(root, "waveU", "u2.log"), "short\n");
  return root;
}

/**
 * The collected status varies with `version` in real content (liveness and log
 * bytes) — `generatedAt` alone is deliberately ignored by the SSE change
 * detection, so a stub that only clocks it would never broadcast.
 */
const statusAt = (version: number): WaveStatus => ({
  generatedAt: `v${version}`,
  waves: [
    {
      id: "T",
      lanes: [
        {
          wave: "T",
          lane: "t1",
          derived: { alive: version > 0, log: { bytes: version, mtimeMs: 0, tail: "" } },
          disagreements: [],
        },
      ],
    },
  ],
});

function get(
  port: number,
  path: string,
  method = "GET",
  timeoutMs = 2_000,
): Promise<{
  status: number;
  headers: IncomingMessage["headers"];
  body: Buffer;
}> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const succeed = (value: { status: number; headers: IncomingMessage["headers"]; body: Buffer }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const options: RequestOptions = { host: "127.0.0.1", port, path, method };
    const req = httpRequest(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () =>
        succeed({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
      );
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      fail(new Error(`timed out after ${timeoutMs}ms waiting for ${method} ${path}`));
    });
    req.on("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
    req.end();
  });
}

/** Reads `status` events off an SSE response as their data payloads. */
class SseReader {
  readonly events: string[] = [];
  private readonly buffer: { text: string } = { text: "" };
  private tail = 0;

  constructor(res: IncomingMessage) {
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      this.buffer.text += chunk;
      for (;;) {
        const end = this.buffer.text.indexOf("\n\n", this.tail);
        if (end < 0) break;
        const block = this.buffer.text.slice(this.tail, end);
        this.tail = end + 2;
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice("data: ".length))
          .join("\n");
        this.events.push(data);
      }
    });
  }

  async waitFor(count: number, timeoutMs = 2_000): Promise<string[]> {
    const deadline = Date.now() + timeoutMs;
    while (this.events.length < count) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${count} SSE events; have ${this.events.length}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return this.events;
  }

  async expectQuiet(ms: number): Promise<void> {
    const before = this.events.length;
    await new Promise((resolve) => setTimeout(resolve, ms));
    if (this.events.length !== before) {
      throw new Error(`expected quiet, received ${this.events.length - before} extra event(s)`);
    }
  }
}

async function openStream(port: number): Promise<{ reader: SseReader; response: IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/api/stream" }, (response) => {
      resolve({ reader: new SseReader(response), response });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("resolvePort (D105)", () => {
  test("undefined PORT is the default 4317", () => {
    expect(resolvePort({})).toBe(4317);
  });

  test("a normal PORT passes through", () => {
    expect(resolvePort({ PORT: "4400" })).toBe(4400);
  });

  test("3000 and 3001 are refused by construction, naming D105", () => {
    expect(() => resolvePort({ PORT: "3000" })).toThrow(/D105/);
    expect(() => resolvePort({ PORT: "3001" })).toThrow(/D105/);
  });

  test("non-numeric and out-of-range ports are refused", () => {
    expect(() => resolvePort({ PORT: "abc" })).toThrow(/invalid PORT/);
    expect(() => resolvePort({ PORT: "-1" })).toThrow(/invalid PORT/);
    expect(() => resolvePort({ PORT: "99999" })).toThrow(/invalid PORT/);
  });
});

describe("routeFor — the route table, enumerated (D106)", () => {
  test("the table is exactly {GET /, GET /tokens.css, GET /api/status, GET /api/stream, GET /api/log/:wave/:lane}", () => {
    expect(routeFor("GET", "/")).toEqual({ kind: "index" });
    expect(routeFor("GET", "/tokens.css")).toEqual({ kind: "tokens" });
    expect(routeFor("GET", "/api/status")).toEqual({ kind: "status" });
    expect(routeFor("GET", "/api/stream")).toEqual({ kind: "stream" });
    expect(routeFor("GET", "/api/log/T/t1")).toEqual({
      kind: "log",
      wave: "T",
      lane: "t1",
      search: expect.any(URLSearchParams),
    });
  });

  test("an absent method or request target still routes", () => {
    expect(routeFor(undefined, "/")).toBe("methodNotAllowed");
    expect(routeFor("GET", undefined)).toEqual({ kind: "index" });
  });

  test("any other method is 405 — including DELETE on the log route", () => {
    expect(routeFor("POST", "/api/status")).toBe("methodNotAllowed");
    expect(routeFor("DELETE", "/api/log/T/t1")).toBe("methodNotAllowed");
    expect(routeFor("PUT", "/")).toBe("methodNotAllowed");
  });

  test("any other path is 404", () => {
    expect(routeFor("GET", "/nope")).toEqual({ kind: "notFound" });
    expect(routeFor("GET", "/api/status/extra")).toEqual({ kind: "notFound" });
    expect(routeFor("GET", "/api/log/T")).toEqual({ kind: "notFound" });
    expect(routeFor("GET", "/api/log/T/t1/extra")).toEqual({ kind: "notFound" });
  });

  test("path segments are validated — traversal is 404 (M4)", () => {
    expect(routeFor("GET", "/api/log/T/../../etc/passwd")).toEqual({ kind: "notFound" });
    expect(routeFor("GET", "/api/log/T/%2e%2e")).toEqual({ kind: "notFound" });
    // URL does not canonicalize this one: two segments, but they fail SEGMENT.
    expect(routeFor("GET", "/api/log/..%2F..%2Fetc/passwd")).toEqual({ kind: "notFound" });
    expect(routeFor("GET", "/api/log/T/..hidden")).toEqual({ kind: "notFound" });
  });

  test("an unparseable request target is 404, not a crash", () => {
    expect(routeFor("GET", "http://[")).toEqual({ kind: "notFound" });
  });
});

describe("the server over real HTTP", () => {
  test("GET / serves the page", async () => {
    const handle = await start({
      port: 0,
      root: await makeFixture(),
      collect: async () => statusAt(0),
    });
    const res = await get(handle.port, "/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    const html = res.body.toString("utf8");
    expect(html).toContain("<table");
    expect(html).toContain('<link rel="stylesheet" href="/tokens.css">');
    expect(html).toContain("stage");
    expect(html).toContain("liveness");
    expect(html).toContain('role="button"');
    expect(html).toContain('addEventListener("keydown"');
    expect(html).toContain("esc(detail.fixed");
    expect(html).toContain("clearInterval(pollTimer)");
  });

  test("GET / is 500 when the page cannot be read", async () => {
    const handle = await start({
      port: 0,
      root: await makeFixture(),
      collect: async () => statusAt(0),
      indexHtmlPath: "/definitely/missing/index.html",
    });
    expect((await get(handle.port, "/")).status).toBe(500);
  });

  test("GET /tokens.css serves the app's dark block as text/css", async () => {
    const root = await makeFixture();
    const tokensPath = join(root, "tokens.css");
    await writeFile(
      tokensPath,
      [
        ":root {",
        "  --color-background: #ffffff;",
        "  --color-surface-2: #f1f5f9;",
        "}",
        ".dark {",
        "  --color-background: #0f0f0f;",
        "  --color-surface-2: #262626;",
        "}",
        "",
      ].join("\n"),
    );
    const handle = await start({
      port: 0,
      root,
      collect: async () => statusAt(0),
      tokensCssPath: tokensPath,
    });
    const res = await get(handle.port, "/tokens.css");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/css");
    const body = res.body.toString("utf8");
    expect(body).toContain("--color-background");
    expect(body).toContain("--color-surface-2");
    // The body carries the dark values, not the light ones — a change that
    // serves the wrong block fails here.
    expect(body).toContain("--color-background: #0f0f0f");
    expect(body).not.toContain("--color-background: #ffffff");
    // Only the dark block is served, never the light `:root`.
    expect(body).not.toContain("#f1f5f9");
  });

  test("GET /tokens.css is 500 naming the file when it cannot be read", async () => {
    const root = await makeFixture();
    const missing = join(root, "does-not-exist", "tokens.css");
    const handle = await start({
      port: 0,
      root,
      collect: async () => statusAt(0),
      tokensCssPath: missing,
    });
    const res = await get(handle.port, "/tokens.css");
    expect(res.status).toBe(500);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.body.toString("utf8")).toContain(missing);
  });

  test("GET /tokens.css is 500 naming the file when it has no dark block", async () => {
    const root = await makeFixture();
    const tokensPath = join(root, "tokens.css");
    await writeFile(tokensPath, ":root { --color-background: #ffffff; }\n");
    const handle = await start({
      port: 0,
      root,
      collect: async () => statusAt(0),
      tokensCssPath: tokensPath,
    });
    const res = await get(handle.port, "/tokens.css");
    expect(res.status).toBe(500);
    expect(res.body.toString("utf8")).toContain(tokensPath);
  });

  test("the page declares no --color-* custom property of its own", async () => {
    const handle = await start({
      port: 0,
      root: await makeFixture(),
      collect: async () => statusAt(0),
    });
    const res = await get(handle.port, "/");
    expect(res.status).toBe(200);
    const html = res.body.toString("utf8");
    // A copied token value would recreate the drift; any --color-* declaration
    // in the page fails this build.
    expect(html).not.toMatch(/--color-[a-z0-9-]+:/);
    // And yet the page does link the served tokens.
    expect(html).toContain('href="/tokens.css"');
  });

  test("GET /api/status returns the collected WaveStatus as JSON", async () => {
    const handle = await start({
      port: 0,
      root: await makeFixture(),
      collect: async () => statusAt(0),
    });
    const res = await get(handle.port, "/api/status");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    const parsed = JSON.parse(res.body.toString("utf8")) as WaveStatus;
    expect(parsed.generatedAt).toEqual(expect.any(String));
    expect(parsed.waves).toEqual(statusAt(0).waves);
  });

  test("GET /api/status is 500 with a one-line body when collect throws", async () => {
    const handle = await start({
      port: 0,
      root: await makeFixture(),
      collect: async () => {
        throw new Error("collect exploded");
      },
    });
    const res = await get(handle.port, "/api/status", "GET", 1_000);
    expect(res.status).toBe(500);
    const body = res.body.toString("utf8");
    expect(body).toBe("internal error");
    expect(body.split("\n")).toHaveLength(1);
  });

  test("POST /api/status is 405; DELETE on the log route is 405; unknown paths are 404", async () => {
    const handle = await start({
      port: 0,
      root: await makeFixture(),
      collect: async () => statusAt(0),
    });
    const post = await get(handle.port, "/api/status", "POST");
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe("GET");
    expect((await get(handle.port, "/api/log/T/t1", "DELETE")).status).toBe(405);
    expect((await get(handle.port, "/nope")).status).toBe(404);
    expect((await get(handle.port, "/api/log/T/../../etc/passwd")).status).toBe(404);
  });

  test("GET /api/log/T/t1?tail=1 returns exactly the last 1 KB", async () => {
    const root = await makeFixture();
    const handle = await start({ port: 0, root, collect: async () => statusAt(0) });
    const whole = await import("node:fs/promises").then((fs) => fs.readFile(join(root, "waveT", "t1.log")));
    const res = await get(handle.port, "/api/log/T/t1?tail=1");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.body.length).toBe(1024);
    expect(res.body.equals(whole.subarray(whole.length - 1024))).toBe(true);
  });

  test("a >1 MB log is tailed without reading the whole file; ?tail=99999 is 400", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-status-big-"));
    roots.push(root);
    await mkdir(join(root, "waveT"));
    const payload = Buffer.concat([Buffer.alloc(1_500_000, 0x61), Buffer.from("TAILEND\n")]);
    const logPath = join(root, "waveT", "t1.log");
    await writeFile(logPath, payload);

    let bytesRead = 0;
    const handle = await start({
      port: 0,
      root,
      collect: async () => statusAt(0),
      deps: {
        ...realDeps,
        open: async (path) => {
          const fh = await realDeps.open(path);
          return {
            stat: () => fh.stat(),
            read: async (buffer, offset, length, position) => {
              const result = await fh.read(buffer, offset, length, position);
              if (path === logPath) bytesRead += result.bytesRead;
              return result;
            },
            close: () => fh.close(),
          };
        },
      },
    });

    const res = await get(handle.port, "/api/log/T/t1?tail=1");
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1024);
    expect(res.body.equals(payload.subarray(payload.length - 1024))).toBe(true);
    expect(bytesRead).toBe(1024);
    expect(bytesRead).toBeLessThan(payload.length);

    const capped = await get(handle.port, "/api/log/T/t1?tail=99999");
    expect(capped.status).toBe(400);
  });

  test("a log smaller than the tail, a missing tail param and a bad tail param all work", async () => {
    const handle = await start({
      port: 0,
      root: await makeFixture(),
      collect: async () => statusAt(0),
    });
    expect((await get(handle.port, "/api/log/U/u2?tail=16")).body.toString("utf8")).toBe("short\n");
    expect((await get(handle.port, "/api/log/U/u2")).body.toString("utf8")).toBe("short\n");
    expect((await get(handle.port, "/api/log/U/u2?tail=abc")).body.toString("utf8")).toBe("short\n");
    expect((await get(handle.port, "/api/log/U/u2?tail=0")).body.toString("utf8")).toBe("short\n");
  });

  test("unknown waves, missing logs and an unreadable root are 404", async () => {
    const root = await makeFixture();
    const handle = await start({ port: 0, root, collect: async () => statusAt(0) });
    expect((await get(handle.port, "/api/log/ZZ/zz")).status).toBe(404);
    expect((await get(handle.port, "/api/log/T/missing")).status).toBe(404);
    const dead = await start({
      port: 0,
      root: join(root, "does-not-exist"),
      collect: async () => statusAt(0),
    });
    expect((await get(dead.port, "/api/log/T/t1")).status).toBe(404);
  });

  test("the default collection wires realDeps against the fixture root", async () => {
    const root = await makeFixture();
    const handle = await start({ port: 0, root });
    const res = await get(handle.port, "/api/status");
    expect(res.status).toBe(200);
    const status = JSON.parse(res.body.toString("utf8")) as WaveStatus;
    expect(status.waves.map((wave) => wave.id)).toEqual(["T", "U"]);
    const t1 = status.waves[0]?.lanes[0];
    expect(t1?.derived.log?.bytes).toBe(3008);
    expect(t1?.derived.gate?.exit).toBe(0);
    expect(t1?.derived.alive).toBe(false);
    expect(t1?.derived.pr).toBeUndefined();
    expect(t1?.reported).toMatchObject({ stage: "gate" });
  });

  test("/api/stream sends a status event on connect and pushes when the injected watcher fires", async () => {
    const root = await makeFixture();
    let version = 0;
    const listeners: Array<() => void> = [];
    // A poll that never fires inside the test: the only path to a second event
    // is the injected watcher callback — no filesystem, no race.
    const handle = await start({
      port: 0,
      root,
      collect: async () => statusAt(version),
      pollMs: 3_600_000,
      watch: (_path, listener) => {
        listeners.push(listener);
        return { close(): void { /* the test owns the lifetime */ } };
      },
    });

    const { reader, response } = await openStream(handle.port);
    try {
      expect(response.headers["content-type"]).toContain("text/event-stream");

      expect(await reader.waitFor(1)).toEqual([JSON.stringify(statusAt(0))]);
      await reader.expectQuiet(200);

      version = 1;
      listeners[0]?.();
      expect(await reader.waitFor(2)).toEqual([
        JSON.stringify(statusAt(0)),
        JSON.stringify(statusAt(1)),
      ]);
    } finally {
      response.destroy();
    }
  });

  // Platform watchers are load-sensitive; the injected-watcher test is the contract; run with WAVE_STATUS_REAL_WATCH=1 to smoke a real watcher.
  test.skipIf(process.env.WAVE_STATUS_REAL_WATCH !== "1")(
    "fs.watch on a real wave dir pushes a status event (smoke)",
    async () => {
      const root = await makeFixture();
      let version = 0;
      const handle = await start({
        port: 0,
        root,
        collect: async () => statusAt(version),
        pollMs: 3_600_000,
        watch: (path, listener) => fsWatch(path, listener),
      });

      const { reader, response } = await openStream(handle.port);
      try {
        expect(await reader.waitFor(1)).toEqual([JSON.stringify(statusAt(0))]);
        version = 1;
        await writeFile(join(root, "waveT", "changed.signal"), "changed\n");
        expect(await reader.waitFor(2, 10_000)).toEqual([
          JSON.stringify(statusAt(0)),
          JSON.stringify(statusAt(1)),
        ]);
      } finally {
        response.destroy();
      }
    },
    15_000,
  );

  test("overlapping watch ticks still push the latest status", async () => {
    const root = await makeFixture();
    let version = 0;
    let blocked = false;
    let release = (): void => undefined;
    let gate = Promise.resolve();
    const listeners: Array<() => void> = [];

    const handle = await start({
      port: 0,
      root,
      collect: async () => {
        const snapshot = version;
        if (blocked) await gate;
        return statusAt(snapshot);
      },
      pollMs: 3_600_000,
      watch: (_path, listener) => {
        listeners.push(listener);
        return { close(): void { /* the test owns the lifetime */ } };
      },
    });

    const { reader, response } = await openStream(handle.port);
    try {
      expect(await reader.waitFor(1)).toEqual([JSON.stringify(statusAt(0))]);

      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      blocked = true;
      version = 1;
      listeners[0]?.();
      version = 2;
      listeners[0]?.();
      release();

      expect(await reader.waitFor(3, 2_000)).toEqual([
        JSON.stringify(statusAt(0)),
        JSON.stringify(statusAt(1)),
        JSON.stringify(statusAt(2)),
      ]);
    } finally {
      response.destroy();
    }
  });

  test("after startup, a watch-triggered refresh calls gh zero times; the poll tick calls it once", async () => {
    const root = await makeFixture();
    const gh = vi.fn(async () => "[]");
    const listeners: Array<() => void> = [];
    const handle = await start({
      port: 0,
      root,
      pollMs: 200,
      deps: { ...realDeps, gh, pgrep: async () => 0 },
      watch: (_path, listener) => {
        listeners.push(listener);
        return { close(): void { /* the test owns the lifetime */ } };
      },
    });

    const afterStart = gh.mock.calls.length;
    expect(afterStart).toBe(1);

    listeners[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(gh.mock.calls.length).toBe(afterStart);

    const deadline = Date.now() + 2_000;
    while (gh.mock.calls.length < afterStart + 1) {
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for the poll tick to call gh; have ${gh.mock.calls.length}, want ${afterStart + 1}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(gh.mock.calls.length).toBe(afterStart + 1);
  });

  test("a poll tick queued behind a watch still refreshes PR facts", async () => {
    const root = await makeFixture();
    const gh = vi.fn(async () => "[]");
    let hang = false;
    let gate = Promise.resolve();
    let release = (): void => undefined;
    const listeners: Array<() => void> = [];
    await start({
      port: 0,
      root,
      pollMs: 80,
      deps: {
        ...realDeps,
        gh,
        pgrep: async () => 0,
        readdir: async (dir) => {
          if (hang) await gate;
          return realDeps.readdir(dir);
        },
      },
      watch: (_path, listener) => {
        listeners.push(listener);
        return { close(): void { /* the test owns the lifetime */ } };
      },
    });

    expect(gh.mock.calls.length).toBe(1);
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    hang = true;
    listeners[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 160));
    expect(gh.mock.calls.length).toBe(1);
    release();
    const deadline = Date.now() + 2_000;
    while (gh.mock.calls.length < 2) {
      if (Date.now() > deadline) {
        throw new Error(`poll queued behind watch never called gh; have ${gh.mock.calls.length}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(gh.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test("/api/stream stays quiet while nothing changed or collection fails, then the poll pushes", async () => {
    let version = 0;
    let failing = false;
    const handle = await start({
      port: 0,
      root: await makeFixture(),
      collect: async () => {
        if (failing) throw new Error("gh is down");
        return statusAt(version);
      },
      pollMs: 40,
    });

    const { reader, response } = await openStream(handle.port);
    try {
      expect(await reader.waitFor(1)).toEqual([JSON.stringify(statusAt(0))]);

      // Unchanged data on the poll tick is not a change; a failing collection is kept quiet.
      await reader.expectQuiet(200);
      failing = true;
      await reader.expectQuiet(200);
      failing = false;

      // The slow poll exists for gh-only changes — no file was touched here.
      version = 1;
      expect(await reader.waitFor(2)).toEqual([
        JSON.stringify(statusAt(0)),
        JSON.stringify(statusAt(1)),
      ]);
    } finally {
      response.destroy();
    }
  });
});

describe("cleanup", () => {
  test("listen rejects when the requested port is already bound", async () => {
    const root = await makeFixture();
    const first = await start({ port: 0, root, collect: async () => statusAt(0) });
    await expect(start({ port: first.port, root, collect: async () => statusAt(0) })).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
  });

  test("close() shuts the server, its watchers and its interval down", async () => {
    const handle = await start({
      port: 0,
      root: await makeFixture(),
      collect: async () => statusAt(0),
      pollMs: 40,
    });
    const port = handle.port;
    await handle.close();
    handles.pop();
    await expect(
      new Promise<void>((resolve, reject) => {
        const req = httpRequest({ host: "127.0.0.1", port, path: "/api/status" }, (res) => {
          res.resume();
          resolve();
        });
        req.on("error", () => reject(new Error("connection refused — server is closed")));
        req.end();
      }),
    ).rejects.toThrow("connection refused — server is closed");
  });
});
