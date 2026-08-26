import { describe, test, expect, vi } from "vitest";
import { PipelineExecutionLog } from "@campaignfoundry/CampaignOrchestration";
import { completeJob, createJob, failJob, getJob, runJob, type JobResult } from "../jobs.js";

const payload = (over: Partial<JobResult> = {}): JobResult => ({
  halted: false,
  assets: [],
  log: new PipelineExecutionLog("camp"),
  ...over,
});

describe("in-memory jobs", () => {
  test("createJob starts running at 0/0 with a UUID id", () => {
    const id = createJob();
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(getJob(id)).toEqual({ status: "running", done: 0, total: 0, log: null });
  });

  test("getJob returns undefined for an unknown id", () => {
    expect(getJob("missing")).toBeUndefined();
  });

  test("completeJob records assets.length as done/total", () => {
    const id = createJob();
    const result = payload({ assets: [{}, {}] as unknown as JobResult["assets"] });
    completeJob(id, result);
    expect(getJob(id)).toMatchObject({ status: "completed", done: 2, total: 2, result });
  });

  test("completeJob uses 0/0 when the run halted", () => {
    const id = createJob();
    completeJob(id, payload({ halted: true, assets: [{}] as unknown as JobResult["assets"] }));
    expect(getJob(id)).toMatchObject({ status: "completed", done: 0, total: 0 });
  });

  test("failJob records the error without a result", () => {
    const id = createJob();
    failJob(id, "need two products");
    expect(getJob(id)).toEqual({ status: "failed", done: 0, total: 0, log: null, error: "need two products" });
  });

  test("runJob lets work complete the job", async () => {
    const id = createJob();
    runJob(id, async () => {
      completeJob(id, payload());
    });
    await vi.waitFor(() => expect(getJob(id)?.status).toBe("completed"));
  });

  test("runJob marks the job failed when work throws", async () => {
    const id = createJob();
    runJob(id, async () => {
      throw new Error("boom");
    });
    await vi.waitFor(() => expect(getJob(id)?.status).toBe("failed"));
    expect(getJob(id)?.error).toBe("boom");
  });

  test("runJob uses a generic message when work rejects a non-Error", async () => {
    const id = createJob();
    runJob(id, async () => {
      throw "plain";
    });
    await vi.waitFor(() => expect(getJob(id)?.error).toBe("Job failed"));
  });
});
