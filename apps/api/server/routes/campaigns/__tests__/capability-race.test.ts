import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createRouter, toWebHandler, type EventHandler } from "h3";
import { getCapabilities, NOT_PROBED_REASON, probeWait, setCapabilities } from "../../../lib/capabilities.js";
import { resetJobs } from "../../../lib/jobs.js";
import planHandler from "../plan.post.js";
import generateHandler from "../generate.post.js";

const web = (path: string, handler: EventHandler) => {
  const app = createApp();
  const router = createRouter();
  router.post(path, handler);
  app.use(router);
  return toWebHandler(app);
};

const callPlan = (body: unknown) =>
  web("/campaigns/plan", planHandler)(
    new Request("http://x/campaigns/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const callGenerate = (body: unknown) =>
  web("/campaigns/generate", generateHandler)(
    new Request("http://x/campaigns/generate?model=procedural", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const motionBrief = () => ({
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
    count: 6,
    seed: 42,
    minDistance: 1,
    axes: {
      layout: ["headline-top", "headline-bottom"],
      tone: ["bold", "subtle"],
      background: { source: ["procedural"] },
      paletteShift: [0, 0.1],
      motion: ["ken-burns-in"],
      duration: [4],
    },
  },
  output: { formats: ["static", "motion"], platforms: ["instagram-feed", "instagram-reel"] },
});

let dir: string;
const origOut = process.env.OUTPUT_DIR;
const origRoot = process.env.PROJECT_ROOT;
const defaultWait = probeWait.timeoutMs;

beforeEach(() => {
  // The generate run paths start a background job on 202; point OUTPUT_DIR and
  // PROJECT_ROOT at a throwaway dir so the job fails fast without touching the repo.
  dir = mkdtempSync(join(tmpdir(), "cf-caprace-"));
  process.env.OUTPUT_DIR = dir;
  process.env.PROJECT_ROOT = dir;
  // The boot-window snapshot, exactly as the module starts out.
  setCapabilities({ motion: false, reason: NOT_PROBED_REASON });
});

afterEach(() => {
  resetJobs();
  probeWait.timeoutMs = defaultWait;
  setCapabilities({ motion: false, reason: NOT_PROBED_REASON });
  if (origOut === undefined) delete process.env.OUTPUT_DIR;
  else process.env.OUTPUT_DIR = origOut;
  if (origRoot === undefined) delete process.env.PROJECT_ROOT;
  else process.env.PROJECT_ROOT = origRoot;
  rmSync(dir, { recursive: true, force: true });
});

describe("run paths vs the capability boot race", () => {
  test("a motion plan that lands in the boot window waits for the probe and plans", async () => {
    const pending = callPlan(motionBrief());
    // One scheduling tick so the handler is inside the wait; the probe landing is
    // what releases it. The outcome is order-independent — no sleeps.
    await new Promise((resolve) => setTimeout(resolve, 0));
    setCapabilities({ motion: true });
    const res = await pending;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { variants: Array<{ motion?: string }> };
    expect(body.variants.length).toBeGreaterThan(0);
    expect(body.variants.some((v) => v.motion !== undefined)).toBe(true);
  });

  test("a motion generate that lands in the boot window waits and is accepted", async () => {
    const pending = callGenerate(motionBrief());
    await new Promise((resolve) => setTimeout(resolve, 0));
    setCapabilities({ motion: true });
    const res = await pending;
    expect(res.status).toBe(202);
    expect(((await res.json()) as { jobId: string }).jobId).toEqual(expect.any(String));
  });

  test("a motion run on a host that cannot encode video is still refused, naming the probe reason", async () => {
    setCapabilities({ motion: false, reason: "ffmpeg-static binary is not available" });
    const plan = await callPlan(motionBrief());
    expect(plan.status).toBe(400);
    expect(((await plan.json()) as { error: string }).error).toMatch(
      /motion output is unavailable \(ffmpeg-static binary is not available\)/,
    );
    const generate = await callGenerate(motionBrief());
    expect(generate.status).toBe(400);
    expect(((await generate.json()) as { error: string }).error).toMatch(
      /motion output is unavailable \(ffmpeg-static binary is not available\)/,
    );
  });

  test("a probe that never lands answers 503 with a retry hint, and a later probe leaves no stale snapshot", async () => {
    probeWait.timeoutMs = 0; // deadline expires immediately: the probe is still pending
    const refused = await callPlan(motionBrief());
    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe("1");
    expect(((await refused.json()) as { error: string }).error).toMatch(/retry the same request/i);
    expect((await callGenerate(motionBrief())).status).toBe(503);

    // The probe lands after the refusal: the snapshot is fresh and the same run succeeds.
    setCapabilities({ motion: true });
    expect(getCapabilities()).toEqual({ motion: true });
    const retried = await callPlan(motionBrief());
    expect(retried.status).toBe(200);
    const body = (await retried.json()) as { variants: Array<{ motion?: string }> };
    expect(body.variants.some((v) => v.motion !== undefined)).toBe(true);
  });
});
