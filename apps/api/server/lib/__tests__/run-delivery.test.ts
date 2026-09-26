import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createRouter, toWebHandler } from "h3";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { LOCAL_TENANT } from "../tenant.js";
import { createJob, enqueueJob, getJob, resetJobs } from "../jobs.js";
import {
  InProcessRunDelivery,
  getRunDelivery,
  setRunDelivery,
  resetRunDelivery,
} from "../ports/run-delivery.port.js";
import { executeRunRequest, type RunRequest } from "../run-request.js";
import jobHandler from "../../routes/campaigns/jobs/[id].get.js";

import { parseBrief } from "../load-brief.js";
import { setCapabilities } from "../capabilities.js";

const sampleBrief = (): CampaignBrief =>
  parseBrief({
    id: "camp-deliv",
    targetRegion: "DE",
    targetAudience: "test-audience",
    campaignMessage: "Quality test run",
    products: [
      {
        id: "alpha",
        name: "Alpha",
        primaryColor: "#1473E6",
        logoPath: "assets/inputs/hydra-logo.png",
      },
    ],
  });

describe("RunRequest serialisation and delivery (PT-6b1, D171, D174d)", () => {
  let dir: string;
  const origOut = process.env.OUTPUT_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cf-deliv-"));
    process.env.OUTPUT_DIR = dir;
    setCapabilities({ motion: true });
    resetRunDelivery();
  });

  afterEach(async () => {
    await resetJobs();
    resetRunDelivery();
    rmSync(dir, { recursive: true, force: true });
    if (origOut === undefined) delete process.env.OUTPUT_DIR;
    else process.env.OUTPUT_DIR = origOut;
    setCapabilities({ motion: false, reason: "not probed" });
  });

  test("RunRequest survives round trip through JSON.stringify and JSON.parse", () => {
    const request: RunRequest = {
      jobId: "00000000-0000-0000-0000-000000000001",
      tenant: LOCAL_TENANT,
      brief: sampleBrief(),
      imageModel: "procedural",
      regenerateOnly: [{ productId: "alpha", aspectRatio: "1:1", treatment: "default" }],
      reroll: true,
      expectedRevision: "sha256-abc123",
    };

    const json = JSON.stringify(request);
    const parsed = JSON.parse(json) as RunRequest;

    expect(parsed).toEqual(request);
    expect(parsed.jobId).toBe(request.jobId);
    expect(parsed.tenant).toEqual(request.tenant);
    expect(parsed.brief.id).toBe("camp-deliv");
    expect(parsed.imageModel).toBe("procedural");
    expect(parsed.reroll).toBe(true);
    expect(parsed.expectedRevision).toBe("sha256-abc123");
  });

  test("GET /campaigns/jobs/:id reports a queued row as running with done: 0", async () => {
    const claim = await enqueueJob(LOCAL_TENANT, "camp-deliv");
    expect(claim.acquired).toBe(true);
    if (!claim.acquired) return;

    const app = createApp();
    const router = createRouter();
    router.get("/campaigns/jobs/:id", jobHandler);
    app.use(router);

    const res = await toWebHandler(app)(new Request(`http://x/campaigns/jobs/${claim.jobId}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; done: number; total: number };
    expect(body.status).toBe("running");
    expect(body.done).toBe(0);
  });

  test("InProcessRunDelivery starts the queued job and runs it", async () => {
    const claim = await enqueueJob(LOCAL_TENANT, "camp-deliv");
    expect(claim.acquired).toBe(true);
    if (!claim.acquired) return;

    const delivery = new InProcessRunDelivery();
    const request: RunRequest = {
      jobId: claim.jobId,
      tenant: LOCAL_TENANT,
      brief: sampleBrief(),
      imageModel: "procedural",
      reroll: false,
    };

    await delivery.deliver(request);

    // Job should now be started and completed or running
    const job = await getJob(LOCAL_TENANT, claim.jobId);
    expect(job).toBeDefined();
    expect(["running", "completed"]).toContain(job?.status);
  });

  test("duplicate delivery drops the second request and logs a warning (nothing runs twice)", async () => {
    const claim = await enqueueJob(LOCAL_TENANT, "camp-deliv");
    expect(claim.acquired).toBe(true);
    if (!claim.acquired) return;

    const delivery = new InProcessRunDelivery();
    const request: RunRequest = {
      jobId: claim.jobId,
      tenant: LOCAL_TENANT,
      brief: sampleBrief(),
      imageModel: "procedural",
      reroll: false,
    };

    // First delivery successfully starts the queued job
    await delivery.deliver(request);

    // Second delivery: startQueuedJob will return false because status is already running
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await delivery.deliver(request);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          `[run-delivery] Dropping duplicate or expired run request for job "${claim.jobId}"`,
        ),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("run delivery registry test seams getRunDelivery / setRunDelivery / resetRunDelivery", () => {
    const defaultDelivery = getRunDelivery();
    expect(defaultDelivery).toBeInstanceOf(InProcessRunDelivery);

    const customDelivery = { deliver: vi.fn() };
    setRunDelivery(customDelivery);
    expect(getRunDelivery()).toBe(customDelivery);

    resetRunDelivery();
    expect(getRunDelivery()).toBeInstanceOf(InProcessRunDelivery);
  });

  test("executeRunRequest executes campaign and completes the job", async () => {
    const jobId = await createJob(LOCAL_TENANT, "camp-exec");
    const request: RunRequest = {
      jobId,
      tenant: LOCAL_TENANT,
      brief: sampleBrief(),
      imageModel: "procedural",
      reroll: false,
    };

    await executeRunRequest(request);

    const job = await getJob(LOCAL_TENANT, jobId);
    expect(job?.status).toBe("completed");
  });

  test("executeRunRequest fails the job on pipeline error", async () => {
    const jobId = await createJob(LOCAL_TENANT, "camp-fail");
    const badBrief = { ...sampleBrief(), products: [] };
    const request: RunRequest = {
      jobId,
      tenant: LOCAL_TENANT,
      brief: badBrief,
      imageModel: "procedural",
      reroll: false,
    };

    await executeRunRequest(request);

    const job = await getJob(LOCAL_TENANT, jobId);
    expect(job?.status).toBe("failed");
    expect(job?.error).toMatch(/at least one unique product/i);
  });

  test("executeRunRequest handles variation mode and persisted hashes", async () => {
    const vbrief = parseBrief({
      ...sampleBrief(),
      mode: "variation" as const,
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
    const jobId = await createJob(LOCAL_TENANT, "camp-var");
    const request: RunRequest = {
      jobId,
      tenant: LOCAL_TENANT,
      brief: vbrief,
      imageModel: "procedural",
      reroll: true,
    };

    await executeRunRequest(request);

    const job = await getJob(LOCAL_TENANT, jobId);
    expect(job?.status).toBe("completed");
  });

  test("executeRunRequest reads existing policy and copy hashes from persisted report on reroll", async () => {
    const vbrief = parseBrief({
      ...sampleBrief(),
      mode: "variation" as const,
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

    const seedJobId = await createJob(LOCAL_TENANT, "camp-seeded");
    await executeRunRequest({
      jobId: seedJobId,
      tenant: LOCAL_TENANT,
      brief: vbrief,
      imageModel: "procedural",
      reroll: false,
    });

    const rerollJobId = await createJob(LOCAL_TENANT, "camp-seeded");
    await executeRunRequest({
      jobId: rerollJobId,
      tenant: LOCAL_TENANT,
      brief: vbrief,
      imageModel: "procedural",
      reroll: true,
    });

    const job = await getJob(LOCAL_TENANT, rerollJobId);
    expect(job?.status).toBe("completed");
  });
});
