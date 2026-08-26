import { describe, test, expect, afterEach } from "vitest";
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

  test("rejects a motion brief with 400 when the capability is off", async () => {
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
