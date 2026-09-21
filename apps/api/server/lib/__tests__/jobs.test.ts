import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { PipelineExecutionLog } from "@campaignfoundry/CampaignOrchestration";
import {
  JOB_TTL_MS,
  RUN_DEADLINE_MS,
  MAX_JOBS,
  acquireJob,
  completeJob,
  createJob,
  deleteJob,
  failJob,
  getJob,
  getRunningJobId,
  hasRunningJob,
  progressJob,
  resetJobs,
  runJob,
  type JobResult,
} from "../jobs.js";

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

  test("progressJob moves a running job off 0/0", async () => {
    const id = await createJob("camp");
    await progressJob(id, 3, 12);
    expect(await getJob(id)).toMatchObject({ status: "running", done: 3, total: 12 });
  });

  test("progressJob leaves a completed job on the counts its settlement wrote", async () => {
    const id = await createJob("camp");
    await completeJob(id, payload({ assets: [] }));
    // A cell still unwinding after the run settled must not walk n/n backwards.
    await progressJob(id, 1, 12);
    expect(await getJob(id)).toMatchObject({ status: "completed", done: 0, total: 0 });
  });

  test("progressJob does not resurrect a failed job", async () => {
    const id = await createJob("camp");
    await failJob(id, "boom");
    // runJob's deadline fails the job while the work it cannot kill keeps ticking.
    await progressJob(id, 5, 12);
    expect(await getJob(id)).toMatchObject({ status: "failed", done: 0, total: 0, error: "boom" });
  });

  test("progressJob on an unknown id is a no-op", async () => {
    await expect(progressJob("missing", 1, 2)).resolves.toBeUndefined();
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
    await completeJob(
      id,
      payload({ halted: true, assets: [{}] as unknown as JobResult["assets"] }),
    );
    expect(await getJob(id)).toMatchObject({ status: "completed", done: 0, total: 0 });
  });

  test("failJob records the error without a result", async () => {
    const id = await createJob("camp");
    await failJob(id, "need two products");
    expect(await getJob(id)).toEqual({
      status: "failed",
      done: 0,
      total: 0,
      log: null,
      error: "need two products",
    });
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

  test("when every job is still running, the facade refuses rather than evicting one", async () => {
    // Pinned the defect, like its counterpart in the store suite: a live run was
    // deleted to make room, losing its lock.
    const oldest = await createJob("c0");
    for (let i = 1; i < MAX_JOBS; i++) await createJob(`c${i}`);
    await expect(createJob("overflow")).rejects.toThrow(/job slots are running/);
    expect(await getJob(oldest)).toBeDefined();
  });

  test("runJob hands the work a signal that aborts at the run deadline", async () => {
    // R5 - the bound that makes refusing to evict safe (D73). Asserted through
    // the signal the work actually receives, not through the constant: a
    // runJob that forgot to pass one, or passed an already-settled one, fails.
    vi.useFakeTimers();
    try {
      const id = await createJob("camp");
      let seen: AbortSignal | undefined;
      runJob(id, async (signal) => {
        seen = signal;
        await new Promise(() => {});
      });
      await vi.waitFor(() => expect(seen).toBeDefined());
      expect(seen!.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(RUN_DEADLINE_MS + 1);
      expect(seen!.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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

  test("runJob handles failJob storage error by deleting job and unblocking campaign", async () => {
    const id = await createJob("camp");
    const store = (await import("../ports/index.js")).getJobStore();
    vi.spyOn(store, "failJob").mockRejectedValueOnce(new Error("disk error"));
    runJob(id, async () => {
      throw new Error("work failed");
    });
    await vi.waitFor(async () => expect(await hasRunningJob("camp")).toBe(false));
    expect(await getJob(id)).toBeUndefined();
  });

  test("runJob ignores error if deleteJob also fails after failJob failure", async () => {
    const id = await createJob("camp");
    const store = (await import("../ports/index.js")).getJobStore();
    vi.spyOn(store, "failJob").mockRejectedValueOnce(new Error("fail error"));
    vi.spyOn(store, "deleteJob").mockRejectedValueOnce(new Error("delete error"));
    runJob(id, async () => {
      throw new Error("work failed");
    });
    await new Promise((r) => setTimeout(r, 20));
  });

  test("acquireJob conditionally creates a running job or returns incumbent", async () => {
    const first = await acquireJob("camp");
    expect(first.acquired).toBe(true);
    if (first.acquired) {
      expect(first.jobId).toBeDefined();
      const second = await acquireJob("camp");
      expect(second).toEqual({ acquired: false, runningJobId: first.jobId });
      await completeJob(first.jobId, payload());
      const third = await acquireJob("camp");
      expect(third.acquired).toBe(true);
    }
  });

  test("deleteJob removes a job from storage", async () => {
    const id = await createJob("camp");
    expect(await getJob(id)).toBeDefined();
    await deleteJob(id);
    expect(await getJob(id)).toBeUndefined();
  });

  test("handle minted survives across separate processes", async () => {
    const id = await createJob("survives");
    const result = spawnSync(
      "yarn",
      [
        "tsx",
        "--input-type=module",
        "-e",
        `import { getJob } from "./apps/api/server/lib/jobs.js";
const job = await getJob(process.argv[1]);
if (!job) process.exit(1);
console.log(JSON.stringify(job));`,
        id,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, OUTPUT_DIR: process.env.OUTPUT_DIR },
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed).toEqual({ status: "running", done: 0, total: 0, log: null });
  });
});

describe("the run deadline is terminal (review, #537)", () => {
  test("the job FAILS at the deadline even when the work keeps going", async () => {
    // Aborting the signal alone was not enough, and this is the test that says
    // so. Every image adapter has a fallback, so an aborted provider call
    // degrades and RESOLVES — the run would carry on compositing and writing
    // files and could complete long after it expired, leaving R1's refusal to
    // evict a runner resting on a slot that never comes back.
    vi.useFakeTimers();
    try {
      const id = await createJob("camp");
      let stillRunning = true;
      runJob(id, async () => {
        // Work that ignores the signal entirely — the worst case, and the one
        // the fallback chain actually produces.
        await new Promise(() => {});
        stillRunning = false;
      });
      await vi.advanceTimersByTimeAsync(RUN_DEADLINE_MS + 1);
      await vi.waitFor(async () => expect((await getJob(id))?.status).toBe("failed"));
      // The work was not killed — it cannot be — but the slot came back.
      expect(stillRunning).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("work that finishes first is untouched by the deadline", async () => {
    const id = await createJob("camp");
    runJob(id, async () => {
      await completeJob(id, payload());
    });
    await vi.waitFor(async () => expect((await getJob(id))?.status).toBe("completed"));
  });
});
