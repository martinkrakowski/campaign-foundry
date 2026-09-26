import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createRouter, toWebHandler } from "h3";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { LOCAL_TENANT } from "../tenant.js";
import { createJob, enqueueJob, getJob, getRunningJobId, resetJobs } from "../jobs.js";
import { InProcessRunDelivery } from "../ports/in-process-run-delivery.js";
import { getRunDelivery, setRunDelivery, resetRunDelivery } from "../ports/index.js";
import type { RunDeliveryPort } from "../ports/run-delivery.port.js";
import { executeRunRequest, type RunRequest } from "../run-request.js";
import { readReport } from "../report.js";
import jobHandler from "../../routes/campaigns/jobs/[id].get.js";
import generateHandler from "../../routes/campaigns/generate.post.js";

import { parseBrief } from "../load-brief.js";
import { setCapabilities } from "../capabilities.js";

// `runCampaign` (lib/pipeline.ts) spied with a call-through: a reroll test
// (finding 7b) asserts the policy/copy hashes it was actually invoked with,
// rather than only the job's terminal status, and the duplicate-delivery test
// (finding 3) asserts "nothing runs twice" by call count — a call-through spy
// here rather than on `runJob` (lib/jobs.ts) itself, because `jobs.ts` is
// reached from `lib/ports/index.ts` through the SAME short cycle
// `InProcessRunDelivery` sits in (`ports/index -> in-process-run-delivery ->
// jobs -> ports/index`, finding 6's own cycle): mocking `jobs.js` from this
// file resolves that cyclic `import("../jobs.js")` back to the real,
// un-mocked module instead of this test's mock, so `runJob` itself is not
// reliably spyable here. `pipeline.ts` sits one hop further out
// (`in-process-run-delivery -> run-request -> pipeline`) and mocks cleanly.
const runCampaignSpy = vi.hoisted(() => vi.fn());
vi.mock("../pipeline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pipeline.js")>();
  runCampaignSpy.mockImplementation(actual.runCampaign);
  return { ...actual, runCampaign: runCampaignSpy };
});

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

/** Poll until a job leaves "queued"/"running" (or disappears), bounded. */
async function awaitSettled(jobId: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const job = await getJob(LOCAL_TENANT, jobId);
    if (!job || (job.status !== "queued" && job.status !== "running")) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`job "${jobId}" did not settle in time`);
}

describe("RunRequest serialisation and delivery (PT-6b1, D171, D174d)", () => {
  let dir: string;
  const origOut = process.env.OUTPUT_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cf-deliv-"));
    process.env.OUTPUT_DIR = dir;
    setCapabilities({ motion: true });
    resetRunDelivery();
    runCampaignSpy.mockClear();
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

  test("InProcessRunDelivery starts the queued job and runs it to completion (finding 4, finding 7)", async () => {
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

    // The job started running (not still queued) immediately after delivery...
    const started = await getJob(LOCAL_TENANT, claim.jobId);
    expect(started?.status).toBe("running");

    // ...and, awaited to its real terminal state (finding 4: this is the same
    // await that keeps the test from leaking its `cf-deliv-*` temp dir past
    // `afterEach`'s `rmSync`), the run actually executed rather than merely
    // having been admitted (finding 7a: "running" alone proves nothing ran).
    await awaitSettled(claim.jobId);
    const finished = await getJob(LOCAL_TENANT, claim.jobId);
    expect(finished?.status).toBe("completed");
    expect(finished?.result?.assets.length).toBeGreaterThan(0);
    expect(runCampaignSpy).toHaveBeenCalledTimes(1);
  });

  test("duplicate delivery drops the second request and logs a warning — nothing runs twice (finding 3)", async () => {
    const claim = await enqueueJob(LOCAL_TENANT, "camp-deliv");
    expect(claim.acquired).toBe(true);
    if (!claim.acquired) return;

    // Slow the first delivery's pipeline call just enough that the job is
    // still "running" (not yet settled) when the second delivery arrives —
    // the window `startQueuedJob`'s own guard has to be doing the work in,
    // not a race that happens to look right. Falls through to the SAME
    // call-through implementation `runCampaignSpy`'s default uses.
    const passThrough = runCampaignSpy.getMockImplementation()!;
    runCampaignSpy.mockImplementationOnce(async (...args: Parameters<typeof passThrough>) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return passThrough(...args);
    });

    const delivery = new InProcessRunDelivery();
    const request: RunRequest = {
      jobId: claim.jobId,
      tenant: LOCAL_TENANT,
      brief: sampleBrief(),
      imageModel: "procedural",
      reroll: false,
    };

    // First delivery successfully starts the queued job; it is still
    // "running" (the artificial delay above hasn't elapsed yet).
    await delivery.deliver(request);
    expect((await getJob(LOCAL_TENANT, claim.jobId))?.status).toBe("running");

    // Second delivery: startQueuedJob returns false because status is already
    // running, so it must warn and drop — never call runCampaign a second
    // time. Deleting the `return` right after the `console.warn` in
    // `InProcessRunDelivery.deliver` would fall through into a second
    // `runJob` call, and the `toHaveBeenCalledTimes(1)` assertion below (after
    // both runs have had time to reach the pipeline) would then see 2.
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

    await awaitSettled(claim.jobId);
    expect(runCampaignSpy).toHaveBeenCalledTimes(1);
  });

  test("a throw from deliver leaves no active row, and a retry is admitted (finding 1)", async () => {
    const boom = new Error("delivery transport unavailable");
    setRunDelivery({
      deliver: async () => {
        throw boom;
      },
    });

    const app = createApp();
    const router = createRouter();
    router.post("/campaigns/generate", generateHandler);
    app.use(router);
    const post = () =>
      toWebHandler(app)(
        new Request("http://x/campaigns/generate?model=procedural", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(sampleBrief()),
        }),
      );

    const failed = await post();
    expect(failed.status).toBe(500);

    // The queued row `enqueueJob` stored before `deliver` threw must be gone —
    // not stranded "queued" for up to QUEUED_TTL_MS refusing every retry with
    // a 409.
    const runningId = await getRunningJobId(LOCAL_TENANT, "camp-deliv");
    expect(runningId).toBeUndefined();

    // A retry, with delivery working this time, is admitted — not a 409.
    setRunDelivery({ deliver: async () => undefined });
    const retried = await post();
    expect(retried.status).toBe(202);
  });

  test("a queued row (delivery not yet started) answers a second POST with 409 (finding 7c)", async () => {
    // A no-op delivery: the queued row is never started, so it is still
    // "queued" — the state finding 7c's route-level 409 test needs, which no
    // existing test exercised.
    setRunDelivery({ deliver: async () => undefined });

    const app = createApp();
    const router = createRouter();
    router.post("/campaigns/generate", generateHandler);
    app.use(router);
    const post = () =>
      toWebHandler(app)(
        new Request("http://x/campaigns/generate?model=procedural", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(sampleBrief()),
        }),
      );

    const first = await post();
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as { jobId: string };

    const second = await post();
    expect(second.status).toBe(409);
    const secondBody = (await second.json()) as { jobId: string; campaignId: string };
    expect(secondBody.jobId).toBe(firstBody.jobId);
    expect(secondBody.campaignId).toBe("camp-deliv");
  });

  test("run delivery registry test seams getRunDelivery / setRunDelivery / resetRunDelivery", () => {
    const defaultDelivery = getRunDelivery(LOCAL_TENANT);
    expect(defaultDelivery).toBeInstanceOf(InProcessRunDelivery);

    const customDelivery: RunDeliveryPort = { deliver: vi.fn() };
    setRunDelivery(customDelivery);
    expect(getRunDelivery(LOCAL_TENANT)).toBe(customDelivery);

    resetRunDelivery();
    expect(getRunDelivery(LOCAL_TENANT)).toBeInstanceOf(InProcessRunDelivery);
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

  test("executeRunRequest reads existing policy and copy hashes from persisted report on reroll (finding 7b)", async () => {
    const vbrief = parseBrief({
      ...sampleBrief(),
      // The report's identity is `result.log.campaignId`, stamped from the
      // brief's OWN id (`report.ts`'s `writeReport`) — not the job store's
      // `campaignId` argument to `createJob`. They must match here so
      // `readReport(..., "camp-seeded")` below finds what the seed run wrote.
      id: "camp-seeded",
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

    const seededReport = (await readReport(LOCAL_TENANT, "camp-seeded")) as {
      policyHash?: string;
      copyHash?: string;
    };
    expect(seededReport.policyHash).toEqual(expect.any(String));

    runCampaignSpy.mockClear();
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

    // The strong assertion (finding 7b): not just that the reroll completed,
    // but that it was invoked with the exact policy/copy hashes persisted by
    // the seed run — `persistedPolicyHash`/`persistedCopyHash` (run-request.ts)
    // read them off the stored report and pass them as `runCampaign`'s 5th and
    // 6th arguments.
    expect(runCampaignSpy).toHaveBeenCalledTimes(1);
    const rerollCall = runCampaignSpy.mock.calls[0]!;
    expect(rerollCall[4]).toBe(seededReport.policyHash);
    expect(rerollCall[5]).toBe(seededReport.copyHash);
  });
});
