import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp, createRouter, toWebHandler, type EventHandler } from "h3";
import { createCanvas } from "@napi-rs/canvas";
import indexHandler from "../index.js";
import generateHandler from "../campaigns/generate.post.js";
import resultHandler from "../campaigns/result.get.js";
import outputHandler from "../output/[...path].get.js";

/** Mount one handler and return a `Request → Response` web handler. */
const web = (method: "get" | "post", path: string, handler: EventHandler) => {
  const app = createApp();
  const router = createRouter();
  if (method === "get") router.get(path, handler);
  else router.post(path, handler);
  app.use(router);
  return toWebHandler(app);
};

const brief = (over: Record<string, unknown> = {}) => ({
  id: "camp",
  targetRegion: "DE",
  targetAudience: "a",
  campaignMessage: "Hi",
  products: [
    { id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "assets/inputs/hydra-logo.png" },
    { id: "beta", name: "B", primaryColor: "#E0218A", logoPath: "assets/inputs/trail-logo.png" },
  ],
  ...over,
});
const png = () => {
  const c = createCanvas(4, 4);
  c.getContext("2d").fillRect(0, 0, 4, 4);
  return c.toBuffer("image/png");
};

const KEYS = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENROUTER_API_KEY"];
let dir: string;
const snap: Record<string, string | undefined> = {};
const origOut = process.env.OUTPUT_DIR;

beforeEach(() => {
  for (const k of KEYS) {
    snap[k] = process.env[k];
    delete process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), "cf-routes-"));
  process.env.OUTPUT_DIR = dir;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
  if (origOut === undefined) delete process.env.OUTPUT_DIR;
  else process.env.OUTPUT_DIR = origOut;
});

describe("GET /", () => {
  test("returns a health payload", async () => {
    const res = await web("get", "/", indexHandler)(new Request("http://x/"));
    expect(await res.json()).toEqual({ status: "ok", app: "api" });
  });
});

describe("POST /campaigns/generate", () => {
  const call = (body: unknown, query = "?model=procedural") =>
    web("post", "/campaigns/generate", generateHandler)(
      new Request(`http://x/campaigns/generate${query}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  test("runs a bare brief (no ?model → default chain) and persists a report", async () => {
    const res = await call(brief(), ""); // no model query → covers the default-model path
    const json = (await res.json()) as { halted: boolean; assets: unknown[] };
    expect(res.status).toBe(200);
    expect(json.halted).toBe(false);
    expect(json.assets).toHaveLength(6);
  });

  test("returns 400 with a default message when body parsing throws a non-Error", async () => {
    const g = globalThis as Record<string, unknown>;
    const original = g.readBody;
    g.readBody = async () => {
      throw "non-error parse failure";
    };
    try {
      const res = await web("post", "/campaigns/generate", generateHandler)(
        new Request("http://x/campaigns/generate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid campaign brief" });
    } finally {
      g.readBody = original;
    }
  });

  test("accepts a { brief, regenerateOnly } envelope and merges", async () => {
    await call(brief()); // seed a full report
    const res = await call({
      brief: brief(),
      regenerateOnly: [{ productId: "alpha", aspectRatio: "1:1", treatment: "default" }],
    });
    const json = (await res.json()) as { assets: { outputPath: string }[] };
    expect(json.assets.map((a) => a.outputPath)).toEqual(["alpha/1x1.png"]);
  });

  test("halts on prohibited copy", async () => {
    const res = await call(brief({ campaignMessage: "A guaranteed miracle cure" }));
    const json = (await res.json()) as { halted: boolean; assets: unknown[] };
    expect(json.halted).toBe(true);
    expect(json.assets).toHaveLength(0);
  });

  test("rejects an invalid brief with 400", async () => {
    const res = await call({ id: "camp" });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toHaveProperty("error");
  });

  test("rejects an unknown model with 400", async () => {
    const res = await call(brief(), "?model=bogus-model");
    expect(res.status).toBe(400);
  });

  test("returns 422 on a business-rule failure (one product)", async () => {
    const res = await call(brief({ products: [{ id: "solo", name: "S", primaryColor: "#111111", logoPath: "x.png" }] }));
    expect(res.status).toBe(422);
  });
});

describe("GET /campaigns/result", () => {
  const call = (query = "") =>
    web("get", "/campaigns/result", resultHandler)(new Request(`http://x/campaigns/result${query}`));

  const seed = () => {
    mkdirSync(resolve(dir, "reports"), { recursive: true });
    writeFileSync(resolve(dir, "report.json"), JSON.stringify({ halted: false, assets: [{ productId: "z" }], log: { campaignId: "latest" } }));
    writeFileSync(resolve(dir, "reports", "camp.json"), JSON.stringify({ halted: false, assets: [{ productId: "alpha" }], log: { campaignId: "camp" } }));
  };

  test("returns the latest report when no id is given", async () => {
    seed();
    expect((await (await call()).json()) as { log: { campaignId: string } }).toMatchObject({ log: { campaignId: "latest" } });
  });

  test("returns a specific campaign's report by id", async () => {
    seed();
    expect((await (await call("?campaignId=camp")).json()) as { log: { campaignId: string } }).toMatchObject({
      log: { campaignId: "camp" },
    });
  });

  test("returns the empty result for an unknown id", async () => {
    seed();
    expect(await (await call("?campaignId=missing")).json()).toEqual({ halted: false, assets: [], log: null });
  });

  test("returns the empty result for an unsafe id", async () => {
    expect(await (await call("?campaignId=../evil")).json()).toEqual({ halted: false, assets: [], log: null });
  });

  test("returns the empty result for a repeated (array) id param", async () => {
    expect(await (await call("?campaignId=a&campaignId=b")).json()).toEqual({ halted: false, assets: [], log: null });
  });
});

describe("GET /output/**", () => {
  const call = (path: string) =>
    web("get", "/output/**:path", outputHandler)(new Request(`http://x/output/${path}`));

  test("streams a generated file with the right content type", async () => {
    writeFileSync(resolve(dir, "hero.png"), png());
    const res = await call("hero.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  test("falls back to octet-stream for an unknown extension", async () => {
    writeFileSync(resolve(dir, "data.bin"), "x");
    const res = await call("data.bin");
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    await res.arrayBuffer(); // drain the file stream before teardown
  });

  test("404s a missing file", async () => {
    const res = await call("nope.png");
    expect(res.status).toBe(404);
  });

  test("400s a path that escapes the output root", async () => {
    // A real HTTP path is normalized before routing, so drive the guard directly with
    // a router param that contains traversal — the case the in-handler check defends.
    const event = { context: { params: { path: "../../etc/passwd" } }, node: { req: {}, res: { statusCode: 200 } } };
    const body = await (outputHandler as unknown as (e: unknown) => Promise<unknown>)(event);
    expect(event.node.res.statusCode).toBe(400);
    expect(body).toEqual({ error: "Invalid path" });
  });

  test("treats a missing path param as the root path (then 404s)", async () => {
    process.env.OUTPUT_DIR = resolve(dir, "does-not-exist"); // root itself is absent → stat 404s
    const event = { context: { params: {} }, node: { req: {}, res: { statusCode: 200 } } };
    const body = await (outputHandler as unknown as (e: unknown) => Promise<unknown>)(event);
    expect(event.node.res.statusCode).toBe(404);
    expect(body).toEqual({ error: "Not found" });
  });
});
