import { afterEach, describe, test, expect, vi, type Mock } from "vitest";

// The default-collection test exercises the realDeps wiring, but its `gh` and
// `pgrep` calls are stubbed at the execFile boundary (they are exercised for
// real in collect.test.ts) so the suite never waits on the network.
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
import { execFile } from "node:child_process";

import { utimesSync, watch as fsWatch } from "node:fs";
import {
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions,
} from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import {
  extractDarkBlock,
  extractRootBlock,
  resolvePort,
  routeFor,
  startServer,
  type ServerHandle,
} from "../server.js";
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
      typeof optionsOrCallback === "function"
        ? optionsOrCallback
        : maybeCallback
    ) as ExecCallback;
    queueMicrotask(() => callback(null, file === "gh" ? "[]" : ""));
    return undefined;
  },
);

const handles: ServerHandle[] = [];
const roots: string[] = [];

/** The app's actual tokens file — the default the server serves — not a fixture. */
const realTokensPath = fileURLToPath(
  new URL("../../../apps/web/src/styles/tokens.css", import.meta.url),
);

afterEach(async () => {
  while (handles.length > 0) {
    await handles.pop()?.close();
  }
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

async function start(
  options: Parameters<typeof startServer>[0],
): Promise<ServerHandle> {
  const handle = await startServer(options);
  handles.push(handle);
  return handle;
}

/**
 * Parses the served page the way a browser would and asserts one `link`
 * element carries BOTH `rel="stylesheet"` and `href="/tokens.css"` — the two
 * facts together. The exact-string form this replaces (`href="/tokens.css"`)
 * matched any element with that href, an `<a>` included, and a formatter's
 * reflow of the tag broke the whole-tag string match; a DOM query survives
 * reflow and still fails when the tag is wrong.
 */
function expectStylesheetLink(html: string): void {
  const window = new Window({
    url: "http://127.0.0.1/",
    settings: {
      disableJavaScriptEvaluation: true,
      disableCSSFileLoading: true,
    },
  });
  try {
    window.document.write(html);
    const stylesheet = window.document.querySelector('link[rel="stylesheet"]');
    expect(stylesheet).not.toBeNull();
    expect(stylesheet?.getAttribute("href")).toBe("/tokens.css");
  } finally {
    window.happyDOM.close();
  }
}

/**
 * A fixture wave-log root: waveT with a >1 KB log, waveU with a small one.
 * The two lane logs get pinned mtimes (T the newer, by a minute) so a test
 * that reads the collected list back has one wave order to expect: the
 * collector's newest-first rule is a function of lane-log activity, so
 * sub-second write order here would make that assertion wall-clock luck.
 */
async function makeFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "wave-status-server-"));
  roots.push(root);
  await mkdir(join(root, "waveT"));
  await mkdir(join(root, "waveU"));
  await mkdir(join(root, "notwave"));
  await writeFile(join(root, "loose.txt"), "not a wave dir\n");
  await writeFile(
    join(root, "waveT", "t1.log"),
    `${"x".repeat(3000)}\nEXIT 0\n`,
  );
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
  const base = Date.now();
  const tMtime = new Date(base - 60_000);
  const uMtime = new Date(base - 600_000);
  utimesSync(join(root, "waveT", "t1.log"), tMtime, tMtime);
  utimesSync(join(root, "waveU", "u2.log"), uMtime, uMtime);
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
          derived: {
            alive: version > 0,
            log: { bytes: version, mtimeMs: 0, tail: "" },
          },
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
    const succeed = (value: {
      status: number;
      headers: IncomingMessage["headers"];
      body: Buffer;
    }) => {
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
        succeed({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }),
      );
      res.on("error", (error) =>
        fail(error instanceof Error ? error : new Error(String(error))),
      );
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      fail(
        new Error(
          `timed out after ${timeoutMs}ms waiting for ${method} ${path}`,
        ),
      );
    });
    req.on("error", (error) =>
      fail(error instanceof Error ? error : new Error(String(error))),
    );
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
        throw new Error(
          `timed out waiting for ${count} SSE events; have ${this.events.length}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return this.events;
  }

  async expectQuiet(ms: number): Promise<void> {
    const before = this.events.length;
    await new Promise((resolve) => setTimeout(resolve, ms));
    if (this.events.length !== before) {
      throw new Error(
        `expected quiet, received ${this.events.length - before} extra event(s)`,
      );
    }
  }
}

async function openStream(
  port: number,
): Promise<{ reader: SseReader; response: IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: "/api/stream" },
      (response) => {
        resolve({ reader: new SseReader(response), response });
      },
    );
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
    expect(routeFor("GET", "/api/log/T/t1/extra")).toEqual({
      kind: "notFound",
    });
  });

  test("path segments are validated — traversal is 404 (M4)", () => {
    expect(routeFor("GET", "/api/log/T/../../etc/passwd")).toEqual({
      kind: "notFound",
    });
    expect(routeFor("GET", "/api/log/T/%2e%2e")).toEqual({ kind: "notFound" });
    // URL does not canonicalize this one: two segments, but they fail SEGMENT.
    expect(routeFor("GET", "/api/log/..%2F..%2Fetc/passwd")).toEqual({
      kind: "notFound",
    });
    expect(routeFor("GET", "/api/log/T/..hidden")).toEqual({
      kind: "notFound",
    });
  });

  test("an unparseable request target is 404, not a crash", () => {
    expect(routeFor("GET", "http://[")).toEqual({ kind: "notFound" });
  });
});

describe("extractDarkBlock", () => {
  test("returns the .dark block through its matching brace", () => {
    expect(
      extractDarkBlock(
        ":root {\n  --color-background: #ffffff;\n}\n.dark {\n  --color-background: #0f0f0f;\n}",
      ),
    ).toBe(".dark {\n  --color-background: #0f0f0f;\n}");
  });

  test("a brace inside a comment does not close the block early", () => {
    // `}` and `*x` inside the comment exercise both comment-closing branches.
    expect(extractDarkBlock(".dark { /* *x } */ --color-a: 1; }")).toBe(
      ".dark { /* *x } */ --color-a: 1; }",
    );
  });

  test("a brace inside a double-quoted string is ignored", () => {
    expect(extractDarkBlock('.dark { --color-a: "}"; }')).toBe(
      '.dark { --color-a: "}"; }',
    );
  });

  test("an escaped quote inside a string does not close it", () => {
    expect(
      extractDarkBlock('.dark { --color-a: "\\" }"; --color-b: 2; }'),
    ).toBe('.dark { --color-a: "\\" }"; --color-b: 2; }');
  });

  test("a brace inside a single-quoted string is ignored", () => {
    expect(extractDarkBlock(".dark { --color-a: '}'; }")).toBe(
      ".dark { --color-a: '}'; }",
    );
  });

  test("nested braces balance before the block closes", () => {
    expect(extractDarkBlock(".dark { --color-a: {nested}; }")).toBe(
      ".dark { --color-a: {nested}; }",
    );
  });

  test("a .dark selector with no brace, or a block that never closes, is undefined", () => {
    expect(extractDarkBlock(".dark")).toBeUndefined();
    expect(extractDarkBlock(".dark { --color-a: 1;")).toBeUndefined();
    expect(extractDarkBlock(".dark /* no closing brace */")).toBeUndefined();
  });

  test("a class that merely starts like .dark is not the block", () => {
    expect(
      extractDarkBlock(
        ".own { --a: 1; }\n.darkish { --c: 3; }\n.dark { --b: 2; }",
      ),
    ).toBe(".dark { --b: 2; }");
  });

  test("a decimal value inside a rule body is not a selector", () => {
    expect(extractDarkBlock(":root { --x: .5; }\n.dark { --y: .5; }")).toBe(
      ".dark { --y: .5; }",
    );
  });

  test("the real tokens.css extracts to a .dark block of token declarations (H1b)", async () => {
    const css = await readFile(realTokensPath, "utf8");
    // A fixture without comments is what let a comment-blind scan ship: the
    // real file's first ".dark" sits inside the header comment (line 9), and
    // the extraction used to start there, serving prose plus the light block.
    const dark = extractDarkBlock(css) ?? "";
    const open = dark.indexOf("{");
    expect(open).toBeGreaterThan(0);
    // The extracted rule's selector is exactly `.dark`.
    expect(dark.slice(0, open).trim()).toBe(".dark");
    // The route serves this extract verbatim. With comments stripped, every
    // non-empty line must be a `--name: value;` declaration — color-scheme is
    // the one standard declaration the block carries beside its tokens — so
    // prose can never again pass as a stylesheet.
    const lines = dark
      .slice(open + 1, dark.lastIndexOf("}"))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^(--[A-Za-z0-9-]+|color-scheme)\s*:\s*[^;]+;$/);
    }
  });
});

describe("extractRootBlock", () => {
  test("returns the :root block through its matching brace", () => {
    expect(
      extractRootBlock(
        ":root {\n  --color-background: #ffffff;\n}\n.dark {\n  --color-background: #0f0f0f;\n}",
      ),
    ).toBe(":root {\n  --color-background: #ffffff;\n}");
  });

  test("a brace inside a comment does not close the block early", () => {
    expect(extractRootBlock(":root { /* *x } */ --color-a: 1; }")).toBe(
      ":root { /* *x } */ --color-a: 1; }",
    );
  });

  test("a brace inside a double-quoted string is ignored", () => {
    expect(extractRootBlock(':root { --color-a: "}"; }')).toBe(
      ':root { --color-a: "}"; }',
    );
  });

  test("an escaped quote inside a string does not close it", () => {
    expect(
      extractRootBlock(':root { --color-a: "\\" }"; --color-b: 2; }'),
    ).toBe(':root { --color-a: "\\" }"; --color-b: 2; }');
  });

  test("a brace inside a single-quoted string is ignored", () => {
    expect(extractRootBlock(":root { --color-a: '}'; }")).toBe(
      ":root { --color-a: '}'; }",
    );
  });

  test("nested braces balance before the block closes", () => {
    expect(extractRootBlock(":root { --color-a: {nested}; }")).toBe(
      ":root { --color-a: {nested}; }",
    );
  });

  test("a :root selector with no brace, or a block that never closes, is undefined", () => {
    expect(extractRootBlock(":root")).toBeUndefined();
    expect(extractRootBlock(":root { --color-a: 1;")).toBeUndefined();
    expect(extractRootBlock(":root /* no closing brace */")).toBeUndefined();
  });

  test("a selector that merely starts like :root is not the block", () => {
    expect(
      extractRootBlock(
        ".own { --a: 1; }\n:rootish { --c: 3; }\n:root { --b: 2; }",
      ),
    ).toBe(":root { --b: 2; }");
  });

  test(":root.dark, :root > body, and :root[data-x] are rejected", () => {
    expect(extractRootBlock(":root.dark { --color: 1; }")).toBeUndefined();
    expect(extractRootBlock(":root > body { --color: 1; }")).toBeUndefined();
    expect(extractRootBlock(":root[data-x] { --color: 1; }")).toBeUndefined();
  });

  test(":root alone and :root within a comma-separated list are accepted", () => {
    expect(extractRootBlock(":root { --color: 1; }")).toBe(
      ":root { --color: 1; }",
    );
    expect(extractRootBlock(":root, html { --color: 1; }")).toBe(
      ":root, html { --color: 1; }",
    );
    expect(extractRootBlock("html, :root { --color: 1; }")).toBe(
      "html, :root { --color: 1; }",
    );
  });

  test("a top-level at-rule or leading brace without selector is handled", () => {
    expect(
      extractRootBlock('@import "base.css";\n:root { --color: 1; }'),
    ).toBe(":root { --color: 1; }");
    expect(extractRootBlock("{ --color: 1; }")).toBeUndefined();
  });

  test("the real tokens.css extracts to a :root block of token declarations", async () => {
    const css = await readFile(realTokensPath, "utf8");
    const root = extractRootBlock(css) ?? "";
    const open = root.indexOf("{");
    expect(open).toBeGreaterThan(0);
    expect(root.slice(0, open).trim()).toBe(":root");
    const lines = root
      .slice(open + 1, root.lastIndexOf("}"))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^(--[A-Za-z0-9-]+|color-scheme)\s*:\s*[^;]+;$/);
    }
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
    expectStylesheetLink(html);
    expect(html).toContain("stage");
    expect(html).toContain("liveness");
    expect(html).toContain(
      '<button type="button" class="wave-band" tabindex="0" aria-expanded=',
    );
    expect(html).toContain('addEventListener("click"');
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

  test("GET /tokens.css serves the app's tokens with :root as base and .dark after it", async () => {
    const root = await makeFixture();
    const tokensPath = join(root, "tokens.css");
    await writeFile(
      tokensPath,
      [
        ":root {",
        "  --color-background: #ffffff;",
        "  --color-surface-2: #f1f5f9;",
        "  --color-brand-primary: #3b82f6;",
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
    expect(body).toContain("--color-brand-primary: #3b82f6");
    // Verify the cascade order: :root first, .dark second, so dark overrides win.
    const rootIndex = body.indexOf(":root {");
    const darkIndex = body.indexOf(".dark {");
    expect(rootIndex).toBeGreaterThanOrEqual(0);
    expect(darkIndex).toBeGreaterThan(rootIndex);
    // Dark override resolves correctly
    const window = new Window({ url: "http://127.0.0.1/" });
    window.document.write(
      '<html class="dark"><head></head><body></body></html>',
    );
    const style = window.document.createElement("style");
    style.textContent = body;
    window.document.head.appendChild(style);
    const cs = window.getComputedStyle(window.document.documentElement);
    expect(cs.getPropertyValue("--color-background")).toBe("#0f0f0f");
    expect(cs.getPropertyValue("--color-surface-2")).toBe("#262626");
    expect(cs.getPropertyValue("--color-brand-primary")).toBe("#3b82f6");
    window.happyDOM.close();
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

  test("GET /tokens.css is 500 naming the file when it has no :root block", async () => {
    const root = await makeFixture();
    const tokensPath = join(root, "tokens.css");
    await writeFile(tokensPath, ".dark { --color-background: #0f0f0f; }\n");
    const handle = await start({
      port: 0,
      root,
      collect: async () => statusAt(0),
      tokensCssPath: tokensPath,
    });
    const res = await get(handle.port, "/tokens.css");
    expect(res.status).toBe(500);
    expect(res.body.toString("utf8")).toContain(tokensPath);
    expect(res.body.toString("utf8")).toContain("has no :root block");
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
    expect(res.body.toString("utf8")).toContain("has no dark block");
  });

  test("every --color-* the page references resolves to a non-empty value", async () => {
    const handle = await start({
      port: 0,
      root: await makeFixture(),
      collect: async () => statusAt(0),
    });
    const pageRes = await get(handle.port, "/");
    const tokensRes = await get(handle.port, "/tokens.css");
    expect(pageRes.status).toBe(200);
    expect(tokensRes.status).toBe(200);
    const html = pageRes.body.toString("utf8");
    const css = tokensRes.body.toString("utf8");
    const styleMatches = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)];
    const referenced = new Set<string>();
    for (const match of styleMatches) {
      for (const m of match[1].matchAll(/var\(\s*(--color-[a-z0-9-]+)/g)) {
        referenced.add(m[1]);
      }
    }
    expect(referenced.size).toBeGreaterThan(0);
    const window = new Window({ url: "http://127.0.0.1/" });
    window.document.write(html.replace(/<script>[\s\S]*?<\/script>/, ""));
    const style = window.document.createElement("style");
    style.textContent = css;
    window.document.head.appendChild(style);
    const cs = window.getComputedStyle(window.document.documentElement);
    for (const token of referenced) {
      const val = cs.getPropertyValue(token).trim();
      expect(val, `token ${token} must resolve`).not.toBe("");
    }
    window.happyDOM.close();
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
    expectStylesheetLink(html);
  });

  test("the page's root element carries the class the served tokens are scoped to", async () => {
    const root = await makeFixture();
    const tokensPath = join(root, "tokens.css");
    await writeFile(
      tokensPath,
      [
        ":root {",
        "  --color-background: #ffffff;",
        "}",
        ".dark {",
        "  --color-background: #0f0f0f;",
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
    const page = await get(handle.port, "/");
    const tokens = await get(handle.port, "/tokens.css");
    expect(page.status).toBe(200);
    expect(tokens.status).toBe(200);
    // The two ends of the <link> are asserted together, from what each side
    // actually serves: the class(es) the served selector requires must be
    // carried by the page's root element. Neither side is asserted literally,
    // so a page that loses its class, and a block re-scoped to another class
    // — or served without any selector at all — each fail here.
    const css = tokens.body.toString("utf8");
    const scoped = [...css.matchAll(/(?:^|\})\s*([^{]+)\{/g)].flatMap((m) =>
      [...m[1].matchAll(/\.([A-Za-z][\w-]*)/g)].map((c) => c[1]),
    );
    expect(scoped.length).toBeGreaterThan(0);
    const html = page.body.toString("utf8");
    const rootTag = html.match(/<html\b[^>]*>/)?.[0] ?? "";
    const classes = (rootTag.match(/\bclass\s*=\s*["']([^"']*)["']/)?.[1] ?? "")
      .split(/\s+/)
      .filter(Boolean);
    for (const name of scoped) expect(classes).toContain(name);
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
    expect((await get(handle.port, "/api/log/T/t1", "DELETE")).status).toBe(
      405,
    );
    expect((await get(handle.port, "/nope")).status).toBe(404);
    expect((await get(handle.port, "/api/log/T/../../etc/passwd")).status).toBe(
      404,
    );
  });

  test("GET /api/log/T/t1?tail=1 returns exactly the last 1 KB", async () => {
    const root = await makeFixture();
    const handle = await start({
      port: 0,
      root,
      collect: async () => statusAt(0),
    });
    const whole = await import("node:fs/promises").then((fs) =>
      fs.readFile(join(root, "waveT", "t1.log")),
    );
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
    const payload = Buffer.concat([
      Buffer.alloc(1_500_000, 0x61),
      Buffer.from("TAILEND\n"),
    ]);
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

  test("a full export returns the entire file, not the tail; carries attachment and Content-Length", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-status-full-"));
    roots.push(root);
    await mkdir(join(root, "waveT"));
    // 32 KB payload is larger than the default 16 KB tail
    const payload = Buffer.concat([
      Buffer.alloc(32_000, 0x61),
      Buffer.from("FULL_EXPORT_END\n"),
    ]);
    const logPath = join(root, "waveT", "t1.log");
    await writeFile(logPath, payload);

    const handle = await start({
      port: 0,
      root,
      collect: async () => statusAt(0),
    });
    const res = await get(handle.port, "/api/log/T/t1?full=1");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.headers["content-disposition"]).toBe(
      'attachment; filename="T-t1.log"',
    );
    expect(res.headers["content-length"]).toBe(String(payload.length));
    expect(res.body.length).toBe(payload.length);
    expect(res.body.equals(payload)).toBe(true);
  });

  test("full=1 and tail=N together: full wins and tail is ignored", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-status-full-wins-"));
    roots.push(root);
    await mkdir(join(root, "waveT"));
    const payload = Buffer.concat([
      Buffer.alloc(32_000, 0x62),
      Buffer.from("FULL_WINS_END\n"),
    ]);
    await writeFile(join(root, "waveT", "t1.log"), payload);

    const handle = await start({
      port: 0,
      root,
      collect: async () => statusAt(0),
    });
    const res = await get(handle.port, "/api/log/T/t1?full=1&tail=1");
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toBe(
      'attachment; filename="T-t1.log"',
    );
    expect(res.headers["content-length"]).toBe(String(payload.length));
    expect(res.body.length).toBe(payload.length);
    expect(res.body.equals(payload)).toBe(true);
  });

  test("full=0 and full=yes behave exactly as if full were absent", async () => {
    const root = await makeFixture();
    const handle = await start({
      port: 0,
      root,
      collect: async () => statusAt(0),
    });
    const baseline = await get(handle.port, "/api/log/T/t1?tail=1");
    const full0 = await get(handle.port, "/api/log/T/t1?full=0&tail=1");
    const fullYes = await get(handle.port, "/api/log/T/t1?full=yes&tail=1");

    expect(full0.status).toBe(200);
    expect(full0.headers["content-disposition"]).toBeUndefined();
    expect(full0.body.equals(baseline.body)).toBe(true);

    expect(fullYes.status).toBe(200);
    expect(fullYes.headers["content-disposition"]).toBeUndefined();
    expect(fullYes.body.equals(baseline.body)).toBe(true);

    const defaultBaseline = await get(handle.port, "/api/log/U/u2");
    const defaultFull0 = await get(handle.port, "/api/log/U/u2?full=0");
    const defaultFullYes = await get(handle.port, "/api/log/U/u2?full=yes");
    expect(defaultFull0.status).toBe(200);
    expect(defaultFull0.headers["content-disposition"]).toBeUndefined();
    expect(defaultFull0.body.equals(defaultBaseline.body)).toBe(true);
    expect(defaultFullYes.status).toBe(200);
    expect(defaultFullYes.headers["content-disposition"]).toBeUndefined();
    expect(defaultFullYes.body.equals(defaultBaseline.body)).toBe(true);
  });

  test("full export of a missing lane is 404", async () => {
    const root = await makeFixture();
    const handle = await start({
      port: 0,
      root,
      collect: async () => statusAt(0),
    });
    expect((await get(handle.port, "/api/log/T/missing?full=1")).status).toBe(
      404,
    );
    expect((await get(handle.port, "/api/log/ZZ/zz?full=1")).status).toBe(404);
  });

  test("a read that fails after the headers are sent leaves the server still answering the next request", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-status-stream-error-"));
    roots.push(root);
    await mkdir(join(root, "waveT"));
    // A directory at t1.log stats successfully (so 200 headers are sent),
    // but reading it as a stream fails asynchronously with EISDIR.
    await mkdir(join(root, "waveT", "t1.log"));
    await writeFile(join(root, "waveT", "t2.log"), "survived\n");

    const handle = await start({
      port: 0,
      root,
      collect: async () => statusAt(0),
    });

    await expect(get(handle.port, "/api/log/T/t1?full=1")).rejects.toThrow();

    const res = await get(handle.port, "/api/log/T/t2?full=1");
    expect(res.status).toBe(200);
    expect(res.body.toString("utf8")).toBe("survived\n");
  });

  test("a log smaller than the tail, a missing tail param and a bad tail param all work", async () => {
    const handle = await start({
      port: 0,
      root: await makeFixture(),
      collect: async () => statusAt(0),
    });
    expect(
      (await get(handle.port, "/api/log/U/u2?tail=16")).body.toString("utf8"),
    ).toBe("short\n");
    expect(
      (await get(handle.port, "/api/log/U/u2")).body.toString("utf8"),
    ).toBe("short\n");
    expect(
      (await get(handle.port, "/api/log/U/u2?tail=abc")).body.toString("utf8"),
    ).toBe("short\n");
    expect(
      (await get(handle.port, "/api/log/U/u2?tail=0")).body.toString("utf8"),
    ).toBe("short\n");
  });

  test("unknown waves, missing logs and an unreadable root are 404", async () => {
    const root = await makeFixture();
    const handle = await start({
      port: 0,
      root,
      collect: async () => statusAt(0),
    });
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
        return {
          close(): void {
            /* the test owns the lifetime */
          },
        };
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
        return {
          close(): void {
            /* the test owns the lifetime */
          },
        };
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
        return {
          close(): void {
            /* the test owns the lifetime */
          },
        };
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
        return {
          close(): void {
            /* the test owns the lifetime */
          },
        };
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
        throw new Error(
          `poll queued behind watch never called gh; have ${gh.mock.calls.length}`,
        );
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
    const first = await start({
      port: 0,
      root,
      collect: async () => statusAt(0),
    });
    await expect(
      start({ port: first.port, root, collect: async () => statusAt(0) }),
    ).rejects.toMatchObject({
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
        const req = httpRequest(
          { host: "127.0.0.1", port, path: "/api/status" },
          (res) => {
            res.resume();
            resolve();
          },
        );
        req.on("error", () =>
          reject(new Error("connection refused — server is closed")),
        );
        req.end();
      }),
    ).rejects.toThrow("connection refused — server is closed");
  });
});
