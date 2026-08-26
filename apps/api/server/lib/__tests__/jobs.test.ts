import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { PipelineExecutionLog } from "@campaignfoundry/CampaignOrchestration";
import {
  JOB_TTL_MS,
  MAX_JOBS,
  completeJob,
  createJob,
  failJob,
  getJob,
  hasRunningJob,
  resetJobs,
  runJob,
  type JobResult,
} from "../jobs.js";

const payload = (over: Partial<JobResult> = {}): JobResult => ({
  halted: false,
  assets: [],
  log: new PipelineExecutionLog("camp"),
  ...over,
});

describe("in-memory jobs", () => {
  beforeEach(() => resetJobs());
  afterEach(() => vi.useRealTimers());

  test("createJob starts running at 0/0 with a UUID id", () => {
    const id = createJob("camp");
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(getJob(id)).toEqual({ status: "running", done: 0, total: 0, log: null });
  });

  test("getJob returns undefined for an unknown id", () => {
    expect(getJob("missing")).toBeUndefined();
  });

  test("hasRunningJob is true only while a job for that campaign is running", () => {
    expect(hasRunningJob("camp")).toBe(false);
    const id = createJob("camp");
    expect(hasRunningJob("camp")).toBe(true);
    expect(hasRunningJob("other")).toBe(false);
    completeJob(id, payload());
    expect(hasRunningJob("camp")).toBe(false);
  });

  test("completeJob records assets.length as done/total", () => {
    const id = createJob("camp");
    const result = payload({ assets: [{}, {}] as unknown as JobResult["assets"] });
    completeJob(id, result);
    expect(getJob(id)).toMatchObject({ status: "completed", done: 2, total: 2, result });
  });

  test("completeJob uses 0/0 when the run halted", () => {
    const id = createJob("camp");
    completeJob(id, payload({ halted: true, assets: [{}] as unknown as JobResult["assets"] }));
    expect(getJob(id)).toMatchObject({ status: "completed", done: 0, total: 0 });
  });

  test("failJob records the error without a result", () => {
    const id = createJob("camp");
    failJob(id, "need two products");
    expect(getJob(id)).toEqual({ status: "failed", done: 0, total: 0, log: null, error: "need two products" });
  });

  test("a settled job expires after JOB_TTL_MS; a running one does not", () => {
    vi.useFakeTimers();
    const settled = createJob("a");
    const running = createJob("b");
    completeJob(settled, payload());
    vi.advanceTimersByTime(JOB_TTL_MS - 1);
    expect(getJob(settled)).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(getJob(settled)).toBeUndefined();
    expect(getJob(running)?.status).toBe("running");
  });

  test("the store is capped at MAX_JOBS, evicting settled jobs before running ones", () => {
    const first = createJob("first");
    failJob(first, "x");
    const kept: string[] = [];
    for (let i = 1; i < MAX_JOBS; i++) kept.push(createJob(`c${i}`));
    // The store is full; the next create must evict one — the settled `first`, not a runner.
    const next = createJob("next");
    expect(getJob(first)).toBeUndefined();
    expect(kept.every((id) => getJob(id)?.status === "running")).toBe(true);
    expect(getJob(next)?.status).toBe("running");
  });

  test("when every job is still running, the oldest runner is evicted", () => {
    const oldest = createJob("c0");
    for (let i = 1; i < MAX_JOBS; i++) createJob(`c${i}`);
    createJob("overflow");
    expect(getJob(oldest)).toBeUndefined();
  });

  test("runJob lets work complete the job", async () => {
    const id = createJob("camp");
    runJob(id, async () => {
      completeJob(id, payload());
    });
    await vi.waitFor(() => expect(getJob(id)?.status).toBe("completed"));
  });

  test("runJob marks the job failed when work throws", async () => {
    const id = createJob("camp");
    runJob(id, async () => {
      throw new Error("boom");
    });
    await vi.waitFor(() => expect(getJob(id)?.status).toBe("failed"));
    expect(getJob(id)?.error).toBe("boom");
  });

  test("runJob uses a generic message when work rejects a non-Error", async () => {
    const id = createJob("camp");
    runJob(id, async () => {
      throw "plain";
    });
    await vi.waitFor(() => expect(getJob(id)?.error).toBe("Job failed"));
  });
});
