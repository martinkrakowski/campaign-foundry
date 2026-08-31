import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp, createRouter, toWebHandler, type EventHandler } from "h3";
import { createCanvas } from "@napi-rs/canvas";
import { createJob, failJob } from "../../lib/jobs.js";
import { setCapabilities } from "../../lib/capabilities.js";
import indexHandler from "../index.js";
import generateHandler from "../campaigns/generate.post.js";
import resultHandler from "../campaigns/result.get.js";
import packageHandler from "../campaigns/package.post.js";
import jobHandler from "../campaigns/jobs/[id].get.js";
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

type JobBody = {
  status: "running" | "completed" | "failed";
  done: number;
  total: number;
  log: unknown;
  result?: {
    halted: boolean;
    assets: { outputPath: string; productId?: string; variantIndex?: number }[];
    log: unknown;
  };
  error?: string;
};

const jobCall = (id: string) =>
  web("get", "/campaigns/jobs/:id", jobHandler)(new Request(`http://x/campaigns/jobs/${id}`));

async function awaitJob(jobId: string): Promise<{ res: Response; body: JobBody }> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const res = await jobCall(jobId);
    const body = (await res.json()) as JobBody;
    if (body.status === "completed" || body.status === "failed") return { res, body };
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for job ${jobId}`);
}

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
    expect(res.status).toBe(202);
    const { jobId } = (await res.json()) as { jobId: string };
    expect(jobId).toEqual(expect.any(String));
    const { body } = await awaitJob(jobId);
    expect(body.status).toBe("completed");
    expect(body.result?.halted).toBe(false);
    expect(body.result?.assets).toHaveLength(6);
    expect(body.done).toBe(6);
    expect(body.total).toBe(6);
    const report = await web("get", "/campaigns/result", resultHandler)(
      new Request("http://x/campaigns/result?campaignId=camp"),
    );
    expect(((await report.json()) as { assets: unknown[] }).assets).toHaveLength(6);
  });

  test("refuses a classic brief that requests motion — the reported bug: it rendered stills", async () => {
    setCapabilities({ motion: true });
    try {
      const res = await call(brief({ output: { formats: ["motion"], platforms: ["instagram-reel"] } }));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/requires mode "variation"/);
    } finally {
      setCapabilities({ motion: false, reason: "not probed" });
    }
  });

  test("refuses a motion brief with 400 while the capability is off (D15 enforcing mode)", async () => {
    // generate is a run path: authoring mode is for listing and persistence only, so a
    // brief this host cannot produce must be refused here rather than deep in the pipeline.
    setCapabilities({ motion: false, reason: "ffmpeg-static binary is not available" });
    try {
      const res = await call(brief({ output: { formats: ["motion"], platforms: ["instagram-reel"] } }));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/motion output is unavailable/);
    } finally {
      setCapabilities({ motion: false, reason: "not probed" });
    }
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
    const seed = await call(brief()); // seed a full report
    await awaitJob(((await seed.json()) as { jobId: string }).jobId);
    const res = await call({
      brief: brief(),
      regenerateOnly: [{ productId: "alpha", aspectRatio: "1:1", treatment: "default" }],
    });
    expect(res.status).toBe(202);
    const { body } = await awaitJob(((await res.json()) as { jobId: string }).jobId);
    expect(body.result?.assets.map((a) => a.outputPath)).toEqual(["alpha/1x1.png"]);
  });

  test("variation re-roll keeps report row count at variation.count", async () => {
    const vbrief = brief({
      mode: "variation",
      variation: {
        count: 4,
        seed: 42,
        minDistance: 1,
        axes: {
          layout: ["headline-top", "headline-bottom"],
          tone: ["bold", "subtle"],
          background: { source: ["procedural"] },
          paletteShift: [0, 0.1],
        },
      },
    });
    const seed = await call(vbrief);
    const { body: first } = await awaitJob(((await seed.json()) as { jobId: string }).jobId);
    expect(first.status).toBe("completed");
    expect(first.result?.assets).toHaveLength(4);
    const slot = first.result?.assets[0];
    expect(slot?.productId).toEqual(expect.any(String));
    expect(slot?.variantIndex).toEqual(expect.any(Number));
    const reroll = await call({
      brief: vbrief,
      regenerateOnly: [{ productId: slot!.productId, variantIndex: slot!.variantIndex }],
    });
    expect(reroll.status).toBe(202);
    const { body: second } = await awaitJob(((await reroll.json()) as { jobId: string }).jobId);
    expect(second.status).toBe("completed");
    expect(second.result?.assets).toHaveLength(1);
    expect(second.result?.assets[0].outputPath).toBe(slot!.outputPath);
    const report = await web("get", "/campaigns/result", resultHandler)(
      new Request("http://x/campaigns/result?campaignId=camp"),
    );
    expect(((await report.json()) as { assets: unknown[] }).assets).toHaveLength(4);
  });

  test("variation re-roll fails when the plan changed since the persisted run", async () => {
    const policy = {
      count: 4,
      seed: 42,
      minDistance: 1,
      axes: {
        layout: ["headline-top", "headline-bottom"],
        tone: ["bold", "subtle"],
        background: { source: ["procedural"] },
        paletteShift: [0, 0.1],
      },
    };
    const seed = await call(brief({ mode: "variation", variation: policy }));
    const { body: first } = await awaitJob(((await seed.json()) as { jobId: string }).jobId);
    expect(first.status).toBe("completed");
    const slot = first.result?.assets[0];
    const reroll = await call({
      brief: brief({ mode: "variation", variation: { ...policy, seed: 43 } }),
      regenerateOnly: [{ productId: slot!.productId, variantIndex: slot!.variantIndex }],
    });
    expect(reroll.status).toBe(202);
    const { body } = await awaitJob(((await reroll.json()) as { jobId: string }).jobId);
    expect(body.status).toBe("failed");
    expect(body.error).toMatch(/^Plan changed since the last run \(policyHash [0-9a-f]{64} ≠ [0-9a-f]{64}\); run the full campaign\.$/);
    const report = await web("get", "/campaigns/result", resultHandler)(
      new Request("http://x/campaigns/result?campaignId=camp"),
    );
    expect(((await report.json()) as { assets: unknown[] }).assets).toHaveLength(4);
  });

  test("variation re-roll without a persisted report is not pinned", async () => {
    const res = await call({
      brief: brief({ mode: "variation", products: [brief().products[0]], variation: { count: 2, seed: 42 } }),
      regenerateOnly: [{ productId: "alpha", variantIndex: 0 }],
    });
    const { body } = await awaitJob(((await res.json()) as { jobId: string }).jobId);
    expect(body.status).toBe("completed");
    expect(body.result?.assets).toHaveLength(1);
  });

  test("variation target productId mismatch fails the job", async () => {
    const vbrief = brief({
      mode: "variation",
      variation: {
        count: 4,
        seed: 42,
        minDistance: 1,
        axes: {
          layout: ["headline-top", "headline-bottom"],
          tone: ["bold", "subtle"],
          background: { source: ["procedural"] },
          paletteShift: [0, 0.1],
        },
      },
    });
    const seed = await call(vbrief);
    const { body: first } = await awaitJob(((await seed.json()) as { jobId: string }).jobId);
    const slot = first.result?.assets[0];
    const res = await call({
      brief: vbrief,
      regenerateOnly: [{ productId: "ghost", variantIndex: slot!.variantIndex, attempt: 1 }],
    });
    const { body } = await awaitJob(((await res.json()) as { jobId: string }).jobId);
    expect(body.status).toBe("failed");
    expect(body.error).toMatch(/does not match plan slot|productId/);
  });

  test("halts on prohibited copy", async () => {
    const res = await call(brief({ campaignMessage: "A guaranteed miracle cure" }));
    expect(res.status).toBe(202);
    const { body } = await awaitJob(((await res.json()) as { jobId: string }).jobId);
    expect(body.status).toBe("completed");
    expect(body.result?.halted).toBe(true);
    expect(body.result?.assets).toHaveLength(0);
    expect(body.done).toBe(0);
    expect(body.total).toBe(0);
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

  test("refuses a second run for a campaign whose job is still running with 409", async () => {
    const id = createJob("camp");
    try {
      const res = await call(brief());
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'A run for campaign "camp" is already in progress.',
      });
    } finally {
      failJob(id, "test teardown");
    }
  });

  test("business-rule failure (zero products) fails the job, not the POST", async () => {
    const res = await call(brief({ products: [] }));
    expect(res.status).toBe(202);
    const { body } = await awaitJob(((await res.json()) as { jobId: string }).jobId);
    expect(body.status).toBe("failed");
    expect(body.error).toEqual(expect.any(String));
    expect(body.result).toBeUndefined();
  });
});

describe("GET /campaigns/jobs/:id", () => {
  test("returns a running job by id", async () => {
    const id = createJob("camp");
    const res = await jobCall(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "running", done: 0, total: 0, log: null });
  });

  test("404s an unknown id", async () => {
    const res = await jobCall("00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Job not found" });
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

  test("returns the empty result when no latest report exists", async () => {
    expect(await (await call()).json()).toEqual({ halted: false, assets: [], log: null });
  });

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
  const call = (path: string, headers: Record<string, string> = {}) =>
    web("get", "/output/**:path", outputHandler)(new Request(`http://x/output/${path}`, { headers }));

  test("streams a generated file with the right content type, length and Accept-Ranges", async () => {
    const bytes = png();
    writeFileSync(resolve(dir, "hero.png"), bytes);
    const res = await call("hero.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe(String(bytes.length));
    expect((await res.arrayBuffer()).byteLength).toBe(bytes.length);
  });

  test("206s a mid-file byte range with Content-Range and the sliced bytes", async () => {
    writeFileSync(resolve(dir, "clip.mp4"), "0123456789");
    const res = await call("clip.mp4", { range: "bytes=2-5" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(res.headers.get("content-length")).toBe("4");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(await res.text()).toBe("2345");
  });

  test("206s an open-ended range to the last byte and clamps an oversized end", async () => {
    writeFileSync(resolve(dir, "clip.mp4"), "0123456789");
    const open = await call("clip.mp4", { range: "bytes=7-" });
    expect(open.status).toBe(206);
    expect(open.headers.get("content-range")).toBe("bytes 7-9/10");
    expect(await open.text()).toBe("789");
    const clamped = await call("clip.mp4", { range: "bytes=8-99" });
    expect(clamped.headers.get("content-range")).toBe("bytes 8-9/10");
    expect(await clamped.text()).toBe("89");
    const suffix = await call("clip.mp4", { range: "bytes=-3" });
    expect(suffix.headers.get("content-range")).toBe("bytes 7-9/10");
    expect(await suffix.text()).toBe("789");
  });

  test("416s a malformed or unsatisfiable range", async () => {
    writeFileSync(resolve(dir, "clip.mp4"), "0123456789");
    for (const range of ["bytes=10-", "bytes=5-2", "bytes=-", "bytes=-0", "items=0-1", "bytes=a-b"]) {
      const res = await call("clip.mp4", { range });
      expect(res.status, range).toBe(416);
      expect(res.headers.get("content-range"), range).toBe("bytes */10");
      expect(await res.json()).toEqual({ error: "Range not satisfiable" });
    }
    writeFileSync(resolve(dir, "empty.mp4"), "");
    expect((await call("empty.mp4", { range: "bytes=-1" })).status).toBe(416);
  });

  test("serves the whole file (200) for a multi-range request", async () => {
    writeFileSync(resolve(dir, "clip.mp4"), "0123456789");
    const res = await call("clip.mp4", { range: "bytes=0-1, 4-5" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-range")).toBeNull();
    expect(await res.text()).toBe("0123456789");
  });

  test("streams an mp4 with video/mp4 content type", async () => {
    writeFileSync(resolve(dir, "clip.mp4"), "ftyp");
    const res = await call("clip.mp4");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    await res.arrayBuffer();
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

  test("refuses the seed cache directory with 404", async () => {
    mkdirSync(resolve(dir, "cache"), { recursive: true });
    writeFileSync(resolve(dir, "cache", "secret.png"), png());
    const file = await call("cache/secret.png");
    expect(file.status).toBe(404);
    expect(await file.json()).toEqual({ error: "Not found" });
    const folder = await call("cache");
    expect(folder.status).toBe(404);
  });

  test("treats a missing path param as the root path (then 404s)", async () => {
    process.env.OUTPUT_DIR = resolve(dir, "does-not-exist"); // root itself is absent → stat 404s
    const event = { context: { params: {} }, node: { req: {}, res: { statusCode: 200 } } };
    const body = await (outputHandler as unknown as (e: unknown) => Promise<unknown>)(event);
    expect(event.node.res.statusCode).toBe(404);
    expect(body).toEqual({ error: "Not found" });
  });
});

describe("POST /campaigns/package", () => {
  const call = (body: unknown) =>
    web("post", "/campaigns/package", packageHandler)(
      new Request("http://x/campaigns/package", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  const reportAsset = (over: Record<string, unknown> = {}) => ({
    productId: "alpha",
    aspectRatio: "1:1",
    outputPath: "alpha/1x1.png",
    treatment: "default",
    complianceScore: 0.5,
    passedCompliance: true,
    logoApplied: true,
    backgroundSource: "procedural",
    ...over,
  });

  const seedReport = (assets: unknown[] = [reportAsset(), reportAsset({ productId: "beta", outputPath: "beta/1x1.png" })]) => {
    mkdirSync(resolve(dir, "reports"), { recursive: true });
    writeFileSync(resolve(dir, "reports", "camp.json"), JSON.stringify({ halted: false, assets, log: { campaignId: "camp" } }));
  };

  const seedPng = (relativePath: string) => {
    mkdirSync(resolve(dir, relativePath, ".."), { recursive: true });
    writeFileSync(resolve(dir, relativePath), png());
  };

  test("packages a two-product classic run for instagram-feed and x; items all pass", async () => {
    seedPng("alpha/1x1.png");
    seedPng("alpha/16x9.png");
    seedPng("beta/1x1.png");
    seedPng("beta/16x9.png");
    seedReport([
      reportAsset(),
      reportAsset({ productId: "beta", outputPath: "beta/1x1.png" }),
      reportAsset({ aspectRatio: "16:9", outputPath: "alpha/16x9.png" }),
      reportAsset({ productId: "beta", aspectRatio: "16:9", outputPath: "beta/16x9.png" }),
      reportAsset({ aspectRatio: "9:16", outputPath: "alpha/9x16.png" }),
    ]);
    const res = await call({ campaignId: "camp", platforms: ["instagram-feed", "x"] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      platforms: Array<{ platformId: string; manifestPath: string; items: Array<{ checks: { size: string }; aspectRatio: string }> }>;
    };
    expect(body.platforms.map((p) => p.platformId)).toEqual(["instagram-feed", "x"]);
    expect(body.platforms[0].items.map((i) => i.aspectRatio)).toEqual(["1:1", "1:1"]);
    expect(body.platforms[1].items.map((i) => i.aspectRatio)).toEqual(["16:9", "16:9"]);
    expect(body.platforms.every((p) => p.items.every((i) => i.checks.size === "pass"))).toBe(true);

    const feedManifest = JSON.parse(
      readFileSync(resolve(dir, "packages/camp/instagram-feed/manifest.json"), "utf8"),
    ) as { items: Array<{ checks: { size: string } }>; packagedAt: string; skipped: number };
    const xManifest = JSON.parse(readFileSync(resolve(dir, "packages/camp/x/manifest.json"), "utf8")) as {
      items: Array<{ checks: { size: string } }>;
    };
    expect(feedManifest.items.every((i) => i.checks.size === "pass")).toBe(true);
    expect(xManifest.items.every((i) => i.checks.size === "pass")).toBe(true);
    expect(feedManifest.skipped).toBe(0);
    expect(typeof feedManifest.packagedAt).toBe("string");
    expect(Number.isNaN(Date.parse(feedManifest.packagedAt))).toBe(false);
    expect(existsSync(resolve(dir, "packages/camp/instagram-feed/alpha/1x1.png"))).toBe(true);
    expect(existsSync(resolve(dir, "packages/camp/x/alpha/16x9.png"))).toBe(true);
  });

  test("packages mp4 + poster for a motion platform only while the capability is on", async () => {
    seedPng("alpha/9x16/v1.png");
    mkdirSync(resolve(dir, "alpha/9x16"), { recursive: true });
    writeFileSync(resolve(dir, "alpha/9x16/v1.mp4"), new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]));
    seedReport([
      reportAsset({
        aspectRatio: "9:16",
        outputPath: "alpha/9x16/v1.png",
        videoPath: "alpha/9x16/v1.mp4",
        durationSec: 6,
        format: "motion",
        variantIndex: 1,
        attempt: 0,
        treatment: "headline-top-bold",
      }),
    ]);
    const off = await call({ campaignId: "camp", platforms: ["instagram-reel"] });
    expect(off.status).toBe(422);
    expect(((await off.json()) as { error: string }).error).toMatch(/not visible/);

    setCapabilities({ motion: true });
    try {
      const res = await call({ campaignId: "camp", platforms: ["instagram-reel"] });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        platforms: Array<{ items: Array<{ format: string; source: string; posterPath: string; durationSec: number; checks: { size: string; duration: string } }> }>;
      };
      expect(body.platforms[0].items).toHaveLength(1);
      expect(body.platforms[0].items[0]).toMatchObject({
        format: "motion",
        source: "alpha/9x16/v1.mp4",
        durationSec: 6,
        checks: { size: "pass", duration: "pass" },
      });
      expect(existsSync(resolve(dir, "packages/camp/instagram-reel/alpha/9x16/v1.mp4"))).toBe(true);
      expect(existsSync(resolve(dir, "packages/camp/instagram-reel/alpha/9x16/v1.png"))).toBe(true);
    } finally {
      setCapabilities({ motion: false, reason: "not probed" });
    }
  });

  test("packages only the included identities and records included/excluded on the manifest", async () => {
    seedPng("alpha/1x1.png");
    seedPng("beta/1x1.png");
    seedPng("gamma/v1.png");
    seedReport([
      reportAsset(),
      reportAsset({ productId: "beta", outputPath: "beta/1x1.png" }),
      reportAsset({ productId: "gamma", outputPath: "gamma/v1.png", variantIndex: 1, attempt: 0 }),
    ]);
    const res = await call({
      campaignId: "camp",
      platforms: ["instagram-feed"],
      include: ["alpha/1:1/default", "gamma/v1"],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      platforms: Array<{ items: Array<{ source: string }>; included: number; excluded: number }>;
    };
    expect(body.platforms[0].items.map((i) => i.source)).toEqual(["alpha/1x1.png", "gamma/v1.png"]);
    expect(body.platforms[0].included).toBe(2);
    expect(body.platforms[0].excluded).toBe(1);
    const onDisk = JSON.parse(
      readFileSync(resolve(dir, "packages/camp/instagram-feed/manifest.json"), "utf8"),
    ) as { included: number; excluded: number };
    expect(onDisk).toMatchObject({ included: 2, excluded: 1 });
    expect(existsSync(resolve(dir, "packages/camp/instagram-feed/beta/1x1.png"))).toBe(false);
  });

  test("returns 400 when include is not an array of strings", async () => {
    let res = await call({ campaignId: "camp", platforms: ["instagram-feed"], include: "alpha/1:1/default" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "include must be an array of strings" });
    res = await call({ campaignId: "camp", platforms: ["instagram-feed"], include: ["ok", 1] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "include must be an array of strings" });
  });

  test("returns 400 when include has more than 1000 entries", async () => {
    const res = await call({
      campaignId: "camp",
      platforms: ["instagram-feed"],
      include: Array.from({ length: 1001 }, (_, i) => `p${i}/1:1/default`),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "include must have at most 1000 entries" });
  });

  test("returns 400 when campaignId is missing", async () => {
    const res = await call({ platforms: ["instagram-feed"] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "campaignId is required" });
  });

  test("returns 400 when campaignId is empty", async () => {
    const res = await call({ campaignId: "", platforms: ["instagram-feed"] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "campaignId is required" });
  });

  test("returns 400 when the body is not an object", async () => {
    const res = await call("nope");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Request body must be an object" });
  });

  test("returns 400 when the body is null", async () => {
    const res = await call(null);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Request body must be an object" });
  });

  test("returns 400 when platforms is not an array", async () => {
    const res = await call({ campaignId: "camp", platforms: "instagram-feed" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "platforms must be a non-empty array of strings" });
  });

  test("returns 400 when platforms is empty", async () => {
    const res = await call({ campaignId: "camp", platforms: [] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "platforms must be a non-empty array of strings" });
  });

  test("returns 400 when platforms contains a non-string", async () => {
    const res = await call({ campaignId: "camp", platforms: ["instagram-feed", 1] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "platforms must be a non-empty array of strings" });
  });

  test("returns 400 with a default message when body parsing throws a non-Error", async () => {
    const g = globalThis as Record<string, unknown>;
    const original = g.readBody;
    g.readBody = async () => {
      throw "non-error parse failure";
    };
    try {
      const res = await web("post", "/campaigns/package", packageHandler)(
        new Request("http://x/campaigns/package", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid package request" });
    } finally {
      g.readBody = original;
    }
  });

  test("returns 404 when the report is missing", async () => {
    const res = await call({ campaignId: "camp", platforms: ["instagram-feed"] });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Campaign report not found" });
  });

  test("returns 404 for an unsafe campaign id", async () => {
    const res = await call({ campaignId: "../evil", platforms: ["instagram-feed"] });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Campaign report not found" });
  });

  test("returns 422 naming tiktok when a hidden platform is requested", async () => {
    seedReport();
    const res = await call({ campaignId: "camp", platforms: ["tiktok"] });
    expect(res.status).toBe(422);
    expect((await res.json() as { error: string }).error).toMatch(/tiktok/);
  });

  test("returns 422 for an unknown platform", async () => {
    seedReport();
    const res = await call({ campaignId: "camp", platforms: ["myspace"] });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'Unknown platform "myspace"' });
  });

  test("de-duplicates platform ids, preserving order", async () => {
    seedPng("alpha/1x1.png");
    seedReport([reportAsset()]);
    const res = await call({
      campaignId: "camp",
      platforms: ["instagram-feed", "linkedin", "instagram-feed"],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { platforms: Array<{ platformId: string }> };
    expect(body.platforms.map((p) => p.platformId)).toEqual(["instagram-feed", "linkedin"]);
  });

  test("skips a GET-result-shaped row and counts it on the manifest", async () => {
    seedPng("alpha/1x1.png");
    seedReport([{ productId: "alpha", aspectRatio: "1:1" }, reportAsset()]);
    const res = await call({ campaignId: "camp", platforms: ["instagram-feed"] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { platforms: Array<{ items: unknown[]; skipped: number }> };
    expect(body.platforms[0].items).toHaveLength(1);
    expect(body.platforms[0].skipped).toBe(1);
    const onDisk = JSON.parse(
      readFileSync(resolve(dir, "packages/camp/instagram-feed/manifest.json"), "utf8"),
    ) as { skipped: number; items: unknown[] };
    expect(onDisk.skipped).toBe(1);
    expect(onDisk.items).toHaveLength(1);
  });

  test("returns 422 when a source PNG is missing, without leaking the server path", async () => {
    seedReport([reportAsset()]);
    const res = await call({ campaignId: "camp", platforms: ["instagram-feed"] });
    expect(res.status).toBe(422);
    const { error } = (await res.json()) as { error: string };
    expect(error).toMatch(/^Platform "instagram-feed":/);
    expect(error).not.toContain(dir);
    expect(error).not.toMatch(/(?:^|[\s'"])\//);
  });

  test("a failed later platform does not mix the earlier platform's directory", async () => {
    seedPng("alpha/1x1.png");
    seedReport([
      reportAsset(),
      reportAsset({ aspectRatio: "16:9", outputPath: "alpha/16x9.png" }),
    ]);
    const res = await call({ campaignId: "camp", platforms: ["instagram-feed", "x"] });
    expect(res.status).toBe(422);
    const { error } = (await res.json()) as { error: string };
    expect(error).toMatch(/^Platform "x":/);
    expect(error).not.toContain(dir);
    expect(existsSync(resolve(dir, "packages/camp/instagram-feed/manifest.json"))).toBe(true);
    expect(existsSync(resolve(dir, "packages/camp/instagram-feed/alpha/1x1.png"))).toBe(true);
    expect(existsSync(resolve(dir, "packages/camp/x"))).toBe(false);
  });

  test("returns 422 when the report has no assets array", async () => {
    mkdirSync(resolve(dir, "reports"), { recursive: true });
    writeFileSync(resolve(dir, "reports", "camp.json"), JSON.stringify({ halted: false, log: { campaignId: "camp" } }));
    const res = await call({ campaignId: "camp", platforms: ["instagram-feed"] });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "Campaign report assets must be an array" });
  });

  test("returns 422 when the report JSON is an array", async () => {
    mkdirSync(resolve(dir, "reports"), { recursive: true });
    writeFileSync(resolve(dir, "reports", "camp.json"), "[]");
    const res = await call({ campaignId: "camp", platforms: ["linkedin"] });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "Campaign report assets must be an array" });
  });

  test("returns 422 when the report JSON is a primitive", async () => {
    mkdirSync(resolve(dir, "reports"), { recursive: true });
    writeFileSync(resolve(dir, "reports", "camp.json"), "5");
    const res = await call({ campaignId: "camp", platforms: ["instagram-feed"] });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "Campaign report assets must be an array" });
  });

  test("returns 422 when the report JSON is null", async () => {
    mkdirSync(resolve(dir, "reports"), { recursive: true });
    writeFileSync(resolve(dir, "reports", "camp.json"), "null");
    const res = await call({ campaignId: "camp", platforms: ["instagram-feed"] });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "Campaign report assets must be an array" });
  });
});
