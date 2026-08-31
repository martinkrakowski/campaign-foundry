import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createRouter, toWebHandler, type EventHandler } from "h3";
import { setCapabilities } from "../../../lib/capabilities.js";
import planHandler from "../plan.post.js";

const web = (handler: EventHandler) => {
  const app = createApp();
  const router = createRouter();
  router.post("/campaigns/plan", handler);
  app.use(router);
  return toWebHandler(app);
};

const call = (body: unknown) =>
  web(planHandler)(
    new Request("http://x/campaigns/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const variationBrief = (over: Record<string, unknown> = {}) => ({
  id: "camp",
  targetRegion: "DE",
  targetAudience: "a",
  campaignMessage: "Hi",
  products: [
    { id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "assets/inputs/hydra-logo.png" },
    { id: "beta", name: "B", primaryColor: "#E0218A", logoPath: "assets/inputs/trail-logo.png" },
  ],
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
  ...over,
});

describe("POST /campaigns/plan", () => {
  // Tests simulate a post-boot server: the probe has landed (the boot-window race
  // itself is covered in capability-race.test.ts).
  beforeEach(() => setCapabilities({ motion: true }));
  afterEach(() => setCapabilities({ motion: false, reason: "not probed" }));

  test("motion slots carry motion + durationSec; static slots do not; estimate carries frames", async () => {
    setCapabilities({ motion: true });
    const res = await call(
      variationBrief({
        variation: { count: 6, seed: 42, minDistance: 1, axes: { motion: ["ken-burns-in"], duration: [4] } },
        output: { formats: ["static", "motion"] },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      estimate: { frames: number };
      variants: Array<{ motion?: string; durationSec?: number }>;
    };
    const motion = body.variants.filter((v) => v.motion !== undefined);
    expect(motion.length).toBeGreaterThan(0);
    expect(motion.every((v) => v.motion === "ken-burns-in" && v.durationSec === 4)).toBe(true);
    expect(body.variants.filter((v) => v.motion === undefined).every((v) => !("durationSec" in v))).toBe(true);
    expect(body.estimate.frames).toBe(motion.length * 4 * 30);
  });

  test("a motion-only brief on a motion platform yields clips at every slot, never stills", async () => {
    // The reported bug: formats [motion] + platforms [instagram-reel] planned two
    // static 16:9 / 1:1 variants and zero clips. The ratio axis drew from all three
    // ratios while only 9:16 could be motion, so every slot "stayed a still" the
    // brief never asked for.
    setCapabilities({ motion: true });
    const res = await call(
      variationBrief({
        variation: { count: 4, seed: 7, minDistance: 1, axes: { motion: ["ken-burns-in"], duration: [4] } },
        output: { formats: ["motion"], platforms: ["instagram-reel"] },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { variants: Array<{ aspectRatio: string; motion?: string }> };
    expect(body.variants.length).toBeGreaterThan(0);
    expect(body.variants.every((v) => v.aspectRatio === "9:16")).toBe(true);
    expect(body.variants.every((v) => v.motion !== undefined)).toBe(true);
  });

  test("motion platforms narrow clips to their ratio (instagram-reel → 9:16 only)", async () => {
    setCapabilities({ motion: true });
    const res = await call(
      variationBrief({
        variation: { count: 6, seed: 42, minDistance: 1, axes: { motion: ["ken-burns-in"], duration: [4] } },
        output: { formats: ["static", "motion"], platforms: ["instagram-feed", "instagram-reel"] },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { variants: Array<{ aspectRatio: string; motion?: string }> };
    const motion = body.variants.filter((v) => v.motion !== undefined);
    expect(motion.length).toBeGreaterThan(0);
    expect(motion.every((v) => v.aspectRatio === "9:16")).toBe(true);
  });

  test("rejects a motion brief with 400 when the probe says the host cannot encode", async () => {
    // A genuine probe verdict — not the transient "not probed" snapshot, which the
    // run path waits out (and 503s on) instead of refusing the brief.
    setCapabilities({ motion: false, reason: "ffmpeg-static binary is not available" });
    const res = await call(variationBrief({ output: { formats: ["motion"] } }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/motion output is unavailable/);
  });

  test("returns a plan summary for a valid variation brief", async () => {
    const res = await call(variationBrief());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      policyHash: string;
      seed: number;
      estimate: { creatives: number };
      variants: Array<{ index: number; productId: string }>;
      policy?: unknown;
    };
    expect(body.seed).toBe(42);
    expect(body.policyHash).toEqual(expect.any(String));
    expect(body.estimate.creatives).toBe(4);
    expect(body.variants).toHaveLength(4);
    expect(body.variants[0]).toEqual(
      expect.objectContaining({
        index: 0,
        productId: expect.any(String),
        aspectRatio: expect.any(String),
        layout: expect.any(String),
        tone: expect.any(String),
        backgroundSource: "procedural",
        paletteShift: expect.any(Number),
      }),
    );
    expect(body.policy).toBeUndefined();
  });

  test("returns 422 when the planner cannot satisfy count", async () => {
    const res = await call(
      variationBrief({
        variation: { count: 999, seed: 1, axes: { layout: ["headline-top"], tone: ["bold"] } },
      }),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(/exceeds axisProductSize|shortfall/);
  });

  test("returns 400 when the brief is not variation mode", async () => {
    const res = await call({
      id: "camp",
      targetRegion: "DE",
      targetAudience: "a",
      campaignMessage: "Hi",
      products: [
        { id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "assets/inputs/hydra-logo.png" },
        { id: "beta", name: "B", primaryColor: "#E0218A", logoPath: "assets/inputs/trail-logo.png" },
      ],
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("not a variation brief");
  });

  test("returns 400 for an unparseable brief", async () => {
    const res = await call({ id: "camp" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/missing required field/);
  });

  test("returns 400 with a default message when body parsing throws a non-Error", async () => {
    const g = globalThis as Record<string, unknown>;
    const original = g.readBody;
    g.readBody = async () => {
      throw "non-error parse failure";
    };
    try {
      const res = await web(planHandler)(
        new Request("http://x/campaigns/plan", {
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
});

describe("POST /campaigns/plan with headline: pool://copy", () => {
  const origRoot = process.env.PROJECT_ROOT;
  let dir: string | undefined;

  // The top-module handler (used by the last test) needs a settled snapshot too;
  // freshHandler sets the fresh-module snapshot for the reset-modules handlers.
  beforeEach(() => setCapabilities({ motion: true }));

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    if (origRoot === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = origRoot;
  });

  const pooledBrief = () =>
    variationBrief({
      variation: {
        count: 4,
        seed: 42,
        minDistance: 1,
        axes: { layout: ["headline-top"], tone: ["bold"], headline: "pool://copy" },
      },
    });

  const freshHandler = async (entries: unknown[] | undefined) => {
    dir = mkdtempSync(join(tmpdir(), "cf-plan-pool-"));
    process.env.PROJECT_ROOT = dir;
    if (entries !== undefined) {
      mkdirSync(join(dir, "briefs", "camp"), { recursive: true });
      writeFileSync(
        join(dir, "briefs", "camp", "pools.json"),
        JSON.stringify({ briefId: "camp", generatedAt: "2026-01-01T00:00:00.000Z", model: "m", entries }),
      );
    }
    vi.resetModules();
    // The fresh module registry starts in the boot window ("not probed"); settle it
    // so these post-boot tests do not wait out the probe.
    const capabilities = await import("../../../lib/capabilities.js");
    capabilities.setCapabilities({ motion: true });
    return web((await import("../plan.post.js")).default as EventHandler);
  };

  const post = (handler: ReturnType<typeof web>, body: unknown) =>
    handler(
      new Request("http://x/campaigns/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  test("returns 422 naming the pool file when no pool exists", async () => {
    const res = await post(await freshHandler(undefined), pooledBrief());
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: 'Headline axis "pool://copy" needs at least one approved entry in copy pool briefs/camp/pools.json.',
    });
  });

  test("returns 422 when the pool has no approved entry", async () => {
    const res = await post(
      await freshHandler([{ id: "h1", text: "A miracle", status: "rejected", reason: "legal" }]),
      pooledBrief(),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(/briefs\/camp\/pools\.json/);
  });

  test("returns 422 naming the pool file when the pool is hand-edited into an invalid shape", async () => {
    const res = await post(await freshHandler([{ id: "h1", text: 42, status: "approved" }]), pooledBrief());
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "Copy pool briefs/camp/pools.json is invalid: entries[0].text must be a string.",
    });
  });

  test("plans with approved headlines and reports them per variant", async () => {
    const res = await post(
      await freshHandler([
        { id: "h1", text: "Stay wild", status: "approved" },
        { id: "h2", text: "Go far", status: "approved" },
      ]),
      pooledBrief(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      estimate: { axisProductSize: number };
      variants: Array<{ headline?: string }>;
    };
    expect(body.estimate.axisProductSize).toBe(2 * 3 * 1 * 1 * 1 * 1 * 2);
    expect(body.variants).toHaveLength(4);
    for (const variant of body.variants) expect(["Stay wild", "Go far"]).toContain(variant.headline);
  });

  test("returns 400 naming the value for any other headline reference", async () => {
    const res = await call(
      variationBrief({ variation: { count: 1, axes: { headline: "pool://other" } } }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/variation.axes.headline.*"pool:\/\/other"/);
  });
});
