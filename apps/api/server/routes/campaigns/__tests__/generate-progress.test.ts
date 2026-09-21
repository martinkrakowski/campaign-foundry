import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createRouter, toWebHandler } from "h3";
import { resetJobs } from "../../../lib/jobs.js";
import { setCapabilities } from "../../../lib/capabilities.js";
import generateHandler from "../generate.post.js";
import jobHandler from "../jobs/[id].get.js";

/**
 * The seam under test is the route's own wiring, so the pipeline is replaced by
 * a stand-in that does exactly two things a real run does — report progress,
 * then take a while. Holding the run open is the point: `completeJob` writes
 * `n/n` whatever happened, so a snapshot read after the run settles cannot tell
 * a reported tick from an unreported one. Only a mid-run read can.
 *
 * The stand-in ends in a failure so the route settles through `failJob` without
 * a report write — this test is about the counter, not the report.
 */
const run = {
  gate: Promise.resolve() as Promise<void>,
  open: () => {},
  reported: undefined as ((done: number, total: number) => void) | undefined,
};

vi.mock("../../../lib/pipeline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/pipeline.js")>();
  return {
    ...actual,
    runCampaign: async (...args: Parameters<typeof actual.runCampaign>) => {
      run.reported = args[6];
      run.reported?.(2, 5);
      await run.gate;
      return { success: false as const, error: new Error("stopped by the test") };
    },
  };
});

const brief = () => ({
  id: "camp",
  targetRegion: "DE",
  targetAudience: "a",
  campaignMessage: "Hi",
  products: [
    { id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "assets/inputs/hydra-logo.png" },
    { id: "beta", name: "B", primaryColor: "#E0218A", logoPath: "assets/inputs/trail-logo.png" },
  ],
});

type JobBody = { status: string; done: number; total: number; error?: string };

describe("POST /campaigns/generate — the job carries the run's real progress", () => {
  let dir: string;
  const origOut = process.env.OUTPUT_DIR;

  const call = (body: unknown) => {
    const app = createApp();
    const router = createRouter();
    router.post("/campaigns/generate", generateHandler);
    app.use(router);
    return toWebHandler(app)(
      new Request("http://x/campaigns/generate?model=procedural", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  };

  const jobCall = async (id: string): Promise<JobBody> => {
    const app = createApp();
    const router = createRouter();
    router.get("/campaigns/jobs/:id", jobHandler);
    app.use(router);
    const res = await toWebHandler(app)(new Request(`http://x/campaigns/jobs/${id}`));
    return (await res.json()) as JobBody;
  };

  /** Poll the job route until `match` holds, or give up — the store write is async. */
  async function until(jobId: string, match: (b: JobBody) => boolean): Promise<JobBody> {
    const deadline = Date.now() + 15_000;
    let last: JobBody | undefined;
    while (Date.now() < deadline) {
      last = await jobCall(jobId);
      if (match(last)) return last;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out; last snapshot ${JSON.stringify(last)}`);
  }

  beforeEach(() => {
    run.gate = Promise.resolve();
    run.open = () => {};
    run.reported = undefined;
    dir = mkdtempSync(join(tmpdir(), "cf-generate-progress-"));
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

  test("a running job reports the counts the pipeline reported, not 0/0", async () => {
    run.gate = new Promise<void>((resolve) => {
      run.open = resolve;
    });
    const res = await call({ brief: brief() });
    expect(res.status).toBe(202);
    const { jobId } = (await res.json()) as { jobId: string };

    const snapshot = await until(jobId, (b) => b.status === "running" && b.done === 2);
    expect(snapshot).toMatchObject({ status: "running", done: 2, total: 5 });

    run.open();
    await until(jobId, (b) => b.status === "failed");
  });

  test("the route hands the pipeline a reporter at all", async () => {
    const res = await call({ brief: brief() });
    expect(res.status).toBe(202);
    const { jobId } = (await res.json()) as { jobId: string };
    await until(jobId, (b) => b.status === "failed");
    // A pipeline built without a sink reports nothing however well the store works.
    expect(run.reported).toBeTypeOf("function");
  });

  test("a store write that fails leaves the run to finish on its own", async () => {
    const jobs = await import("../../../lib/jobs.js");
    const spy = vi.spyOn(jobs, "progressJob").mockRejectedValue(new Error("disk full"));
    try {
      const res = await call({ brief: brief() });
      expect(res.status).toBe(202);
      const { jobId } = (await res.json()) as { jobId: string };
      // Progress is advisory: the counter could not be persisted and the run
      // still settles on its own verdict rather than on the counter's.
      const settled = await until(jobId, (b) => b.status === "failed");
      expect(settled.error).toBe("stopped by the test");
      // Without this the test passes whether or not the rejection was ever
      // raised — the run fails for its own reasons either way.
      expect(spy).toHaveBeenCalledWith(expect.any(String), 2, 5);
    } finally {
      spy.mockRestore();
    }
  });
});
