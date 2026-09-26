import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createRouter, toWebHandler } from "h3";
import { err } from "@campaignfoundry/shared";
import { getRunningJobId, resetJobs } from "../../../lib/jobs.js";
import { setCapabilities } from "../../../lib/capabilities.js";
import { resetUsageStore, setUsageStore } from "../../../lib/ports/index.js";
import type { UsageRecord, UsageStorePort } from "../../../lib/ports/usage-store.port.js";
import { LOCAL_TENANT } from "../../../lib/tenant.js";
import generateHandler from "../generate.post.js";
import jobHandler from "../jobs/[id].get.js";

// A refused run must never reach the pipeline (asserted below); an admitted one
// doesn't need it to actually run — admission is what this file tests — so the
// stub settles the job immediately instead of running the real (offline,
// procedural) pipeline, which would otherwise still be writing into `dir` when
// `afterEach` removes it (the #567 shape).
const runCampaignSpy = vi.hoisted(() => vi.fn(async () => err(new Error("stub: admission test"))));
vi.mock("../../../lib/pipeline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/pipeline.js")>();
  return { ...actual, runCampaign: runCampaignSpy };
});

const brief = (over: Record<string, unknown> = {}) => ({
  id: "camp",
  targetRegion: "DE",
  targetAudience: "a",
  campaignMessage: "Hi",
  products: [
    { id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "assets/inputs/hydra-logo.png" },
  ],
  ...over,
});

/** A usage store double answering a fixed quota and this-month count. */
function usageDouble(
  quota: number | null,
  countThisMonth: number,
): UsageStorePort & { readonly records: UsageRecord[] } {
  const records: UsageRecord[] = [];
  return {
    records,
    record: async (usage) => {
      records.push(usage);
    },
    countThisMonth: async () => countThisMonth,
    quota: async () => quota,
    reserve: async () => (quota !== null && countThisMonth >= quota ? null : "res-1"),
    settle: async (_id, usage) => {
      records.push(usage);
    },
    release: async () => {},
  };
}

/**
 * PT-7a, D175: the admission region in `generate.post.ts` refuses a run over
 * its org's monthly quota before the job claim — before any provider call.
 */
describe("POST /campaigns/generate — admission is gated on the org's monthly quota", () => {
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

  const jobCall = (id: string) => {
    const app = createApp();
    const router = createRouter();
    router.get("/campaigns/jobs/:id", jobHandler);
    app.use(router);
    return toWebHandler(app)(new Request(`http://x/campaigns/jobs/${id}`));
  };

  /** Settle before teardown, so `afterEach`'s rmSync never races an in-flight job. */
  async function awaitSettled(jobId: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const body = (await (await jobCall(jobId)).json()) as { status: string };
      if (body.status === "completed" || body.status === "failed") return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`timed out waiting for job ${jobId} to settle`);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cf-generate-quota-"));
    process.env.OUTPUT_DIR = dir;
    setCapabilities({ motion: true });
    runCampaignSpy.mockClear();
  });
  afterEach(async () => {
    await resetJobs();
    resetUsageStore();
    rmSync(dir, { recursive: true, force: true });
    if (origOut === undefined) delete process.env.OUTPUT_DIR;
    else process.env.OUTPUT_DIR = origOut;
    setCapabilities({ motion: false, reason: "not probed" });
  });

  test("a run at exactly the quota is refused with 429, no provider call and no job", async () => {
    setUsageStore(usageDouble(2, 2));
    const res = await call(brief());
    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({
      error: `Campaign "camp" would exceed its org's monthly generation quota.`,
      code: "quota_exceeded",
    });
    expect(runCampaignSpy).not.toHaveBeenCalled();
    expect(await getRunningJobId(LOCAL_TENANT, "camp")).toBeUndefined();
  });

  test("a run below the quota is admitted", async () => {
    setUsageStore(usageDouble(2, 1));
    const res = await call(brief());
    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: string };
    expect(body.jobId).toEqual(expect.any(String));
    expect(runCampaignSpy).toHaveBeenCalledOnce();
    await awaitSettled(body.jobId);
  });

  test("a null quota is unlimited: a heavily used org is still admitted", async () => {
    setUsageStore(usageDouble(null, 1_000_000));
    const res = await call(brief());
    expect(res.status).toBe(202);
    const { jobId } = (await res.json()) as { jobId: string };
    expect(runCampaignSpy).toHaveBeenCalledOnce();
    await awaitSettled(jobId);
  });
});
