import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { PipelineExecutionLog } from "@campaignfoundry/CampaignOrchestration";
import {
  JOB_TTL_MS,
  MAX_JOBS,
  completeJob,
  createJob,
  failJob,
  getJob,
  getRunningJobId,
  hasRunningJob,
  resetJobs,
  runJob,
  type JobResult,
} from "../jobs.js";
import { getJobStore } from "../ports/index.js";

const payload = (over: Partial<JobResult> = {}): JobResult => ({
  halted: false,
  assets: [],
  log: new PipelineExecutionLog("camp", () => new Date("2026-01-01T00:00:00.000Z")),
  ...over,
});

describe("jobs port facade", () => {
  beforeEach(async () => {
    await resetJobs();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await resetJobs();
  });

  test("createJob starts running at 0/0 with a UUID id", async () => {
    const id = await createJob("camp");
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(await getJob(id)).toEqual({ status: "running", done: 0, total: 0, log: null });
  });

  test("getJob returns undefined for an unknown id", async () => {
    expect(await getJob("missing")).toBeUndefined();
  });

  test("hasRunningJob is true only while a job for that campaign is running", async () => {
    expect(await hasRunningJob("camp")).toBe(false);
    const id = await createJob("camp");
    expect(await hasRunningJob("camp")).toBe(true);
    expect(await hasRunningJob("other")).toBe(false);
    await completeJob(id, payload());
    expect(await hasRunningJob("camp")).toBe(false);
  });

  test("getRunningJobId names the running job's handle, and nothing once it settles", async () => {
    expect(await getRunningJobId("camp")).toBeUndefined();
    const id = await createJob("camp");
    expect(await getRunningJobId("camp")).toBe(id);
    expect(await getRunningJobId("other")).toBeUndefined();
    await completeJob(id, payload());
    expect(await getRunningJobId("camp")).toBeUndefined();
  });

  test("completeJob records assets.length as done/total", async () => {
    const id = await createJob("camp");
    const result = payload({ assets: [{}, {}] as unknown as JobResult["assets"] });
    await completeJob(id, result);
    expect(await getJob(id)).toMatchObject({ status: "completed", done: 2, total: 2, result });
  });

  test("completeJob uses 0/0 when the run halted", async () => {
    const id = await createJob("camp");
    await completeJob(id, payload({ halted: true, assets: [{}] as unknown as JobResult["assets"] }));
    expect(await getJob(id)).toMatchObject({ status: "completed", done: 0, total: 0 });
  });

  test("failJob records the error without a result", async () => {
    const id = await createJob("camp");
    await failJob(id, "need two products");
    expect(await getJob(id)).toEqual({ status: "failed", done: 0, total: 0, log: null, error: "need two products" });
  });

  test("a settled job expires after JOB_TTL_MS; a running one does not", async () => {
    vi.useFakeTimers();
    const settled = await createJob("a");
    const running = await createJob("b");
    await completeJob(settled, payload());
    vi.advanceTimersByTime(JOB_TTL_MS - 1);
    expect(await getJob(settled)).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(await getJob(settled)).toBeUndefined();
    expect((await getJob(running))?.status).toBe("running");
  });

  test("the store is capped at MAX_JOBS, evicting settled jobs before running ones", async () => {
    const first = await createJob("first");
    await failJob(first, "x");
    const kept: string[] = [];
    for (let i = 1; i < MAX_JOBS; i++) kept.push(await createJob(`c${i}`));
    // The store is full; the next create must evict one — the settled `first`, not a runner.
    const next = await createJob("next");
    expect(await getJob(first)).toBeUndefined();
    for (const id of kept) {
      expect((await getJob(id))?.status).toBe("running");
    }
    expect((await getJob(next))?.status).toBe("running");
  });

  test("when every job is still running, the oldest runner is evicted", async () => {
    const oldest = await createJob("c0");
    for (let i = 1; i < MAX_JOBS; i++) await createJob(`c${i}`);
    await createJob("overflow");
    expect(await getJob(oldest)).toBeUndefined();
  });

  test("runJob lets work complete the job", async () => {
    const id = await createJob("camp");
    runJob(id, async () => {
      await completeJob(id, payload());
    });
    await vi.waitFor(async () => expect((await getJob(id))?.status).toBe("completed"));
  });

  test("runJob marks the job failed when work throws", async () => {
    const id = await createJob("camp");
    runJob(id, async () => {
      throw new Error("boom");
    });
    await vi.waitFor(async () => expect((await getJob(id))?.status).toBe("failed"));
    expect((await getJob(id))?.error).toBe("boom");
  });

  test("runJob uses a generic message when work rejects a non-Error", async () => {
    const id = await createJob("camp");
    runJob(id, async () => {
      throw "plain";
    });
    await vi.waitFor(async () => expect((await getJob(id))?.error).toBe("Job failed"));
  });

  test("handle minted survives across separate store instances", async () => {
    const store = getJobStore();
    const id = await createJob("survives");
    const job = await store.getJob(id);
    expect(job).toEqual({ status: "running", done: 0, total: 0, log: null });
  });
});
