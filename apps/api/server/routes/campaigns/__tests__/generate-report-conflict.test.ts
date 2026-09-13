import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createRouter, toWebHandler } from "h3";
import { resetJobs } from "../../../lib/jobs.js";
import { setCapabilities } from "../../../lib/capabilities.js";
import generateHandler from "../generate.post.js";
import jobHandler from "../jobs/[id].get.js";

/**
 * The gate a run waits on inside `runCampaign`. A test that leaves it open holds the
 * run between the read it started from and the write it ends with, which is the
 * interleaving `writeReport`'s conditional write refuses — deterministic here
 * instead of left to the scheduler, which is arbitrary about who wins.
 */
const run = { gate: Promise.resolve() as Promise<void>, open: () => {} };

vi.mock("../../../lib/pipeline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/pipeline.js")>();
  return {
    ...actual,
    runCampaign: async (...args: Parameters<typeof actual.runCampaign>) => {
      await run.gate;
      return actual.runCampaign(...args);
    },
  };
});

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

type JobBody = {
  status: "running" | "completed" | "failed";
  error?: string;
  result?: { assets: unknown[] };
};

describe("POST /campaigns/generate — the report merge is a conditional write", () => {
  let dir: string;
  const origOut = process.env.OUTPUT_DIR;

  const call = (body: unknown) => {
    const app = createApp();
    const router = createRouter();
    router.post("/campaigns/generate", generateHandler);
    app.use(router);
    return toWebHandler(app)(new Request("http://x/campaigns/generate?model=procedural", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
  };

  const jobCall = (id: string) => {
    const app = createApp();
    const router = createRouter();
    router.get("/campaigns/jobs/:id", jobHandler);
    app.use(router);
    return toWebHandler(app)(new Request(`http://x/campaigns/jobs/${id}`));
  };

  async function awaitJob(jobId: string): Promise<JobBody> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const res = await jobCall(jobId);
      const body = (await res.json()) as JobBody;
      if (body.status === "completed" || body.status === "failed") return body;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out waiting for job ${jobId}`);
  }

  beforeEach(() => {
    run.gate = Promise.resolve();
    run.open = () => {};
    dir = mkdtempSync(join(tmpdir(), "cf-report-conflict-"));
    process.env.OUTPUT_DIR = dir;
    setCapabilities({ motion: true });
  });
  afterEach(async () => {
    await resetJobs();
    rmSync(dir, { recursive: true, force: true });
    if (origOut === undefined) delete process.env.OUTPUT_DIR;
    else process.env.OUTPUT_DIR = origOut;
    setCapabilities({ motion: false, reason: "not probed" });
  });

  test("a re-roll whose report moves under it fails the job and writes nothing", async () => {
    const seed = await (await call(brief())).json();
    const seeded = await awaitJob((seed as { jobId: string }).jobId);
    expect(seeded.status).toBe("completed");
    const reportPath = join(dir, "reports", "camp.json");

    // Hold this run inside the pipeline so the report can move while it is in flight.
    run.gate = new Promise<void>((resolve) => {
      run.open = resolve;
    });
    const res = await call({
      brief: brief(),
      regenerateOnly: [{ productId: "alpha", aspectRatio: "1:1", treatment: "default" }],
    });
    expect(res.status).toBe(202);

    // Another run's merge lands meanwhile — the same campaign, different bytes.
    writeFileSync(
      reportPath,
      JSON.stringify({
        halted: false,
        assets: [
          {
            productId: "alpha",
            aspectRatio: "1:1",
            treatment: "default",
            outputPath: "other/1x1.png",
          },
        ],
      }),
    );
    run.open();

    const { jobId } = (await res.json()) as { jobId: string };
    const body = await awaitJob(jobId);
    expect(body.status).toBe("failed");
    expect(body.error).toBe('Report for campaign "camp" was modified by another run.');

    // Refused means it wrote nothing: the report still holds the run that landed.
    const stored = JSON.parse(readFileSync(reportPath, "utf8")) as { assets: { outputPath: string }[] };
    expect(stored.assets[0].outputPath).toBe("other/1x1.png");
  });
});
