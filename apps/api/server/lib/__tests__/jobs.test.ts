import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { PipelineExecutionLog } from "@campaignfoundry/CampaignOrchestration";
import {
  JOB_TTL_MS,
  HEARTBEAT_INTERVAL_MS,
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
import { JobLeaseLostError } from "../ports/pg-job-store.js";

import { LOCAL_TENANT } from "../tenant.js";
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
    const id = await createJob(LOCAL_TENANT, "camp");
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(await getJob(LOCAL_TENANT, id)).toEqual({
      status: "running",
      done: 0,
      total: 0,
      log: null,
    });
  });

  test("progressJob moves a running job off 0/0", async () => {
    const id = await createJob(LOCAL_TENANT, "camp");
    await progressJob(LOCAL_TENANT, id, 3, 12);
    expect(await getJob(LOCAL_TENANT, id)).toMatchObject({ status: "running", done: 3, total: 12 });
  });

  test("progressJob leaves a completed job on the counts its settlement wrote", async () => {
    const id = await createJob(LOCAL_TENANT, "camp");
    await completeJob(LOCAL_TENANT, id, payload({ assets: [] }));
    // A cell still unwinding after the run settled must not walk n/n backwards.
    await progressJob(LOCAL_TENANT, id, 1, 12);
    expect(await getJob(LOCAL_TENANT, id)).toMatchObject({
      status: "completed",
      done: 0,
      total: 0,
    });
  });

  test("progressJob does not resurrect a failed job", async () => {
    const id = await createJob(LOCAL_TENANT, "camp");
    await failJob(LOCAL_TENANT, id, "boom");
    // runJob's deadline fails the job while the work it cannot kill keeps ticking.
    await progressJob(LOCAL_TENANT, id, 5, 12);
    expect(await getJob(LOCAL_TENANT, id)).toMatchObject({
      status: "failed",
      done: 0,
      total: 0,
      error: "boom",
    });
  });

  test("progressJob on an unknown id is a no-op", async () => {
    await expect(progressJob(LOCAL_TENANT, "missing", 1, 2)).resolves.toBeUndefined();
  });

  test("getJob returns undefined for an unknown id", async () => {
    expect(await getJob(LOCAL_TENANT, "missing")).toBeUndefined();
  });

  test("hasRunningJob is true only while a job for that campaign is running", async () => {
    expect(await hasRunningJob(LOCAL_TENANT, "camp")).toBe(false);
    const id = await createJob(LOCAL_TENANT, "camp");
    expect(await hasRunningJob(LOCAL_TENANT, "camp")).toBe(true);
    expect(await hasRunningJob(LOCAL_TENANT, "other")).toBe(false);
    await completeJob(LOCAL_TENANT, id, payload());
    expect(await hasRunningJob(LOCAL_TENANT, "camp")).toBe(false);
  });

  test("getRunningJobId names the running job's handle, and nothing once it settles", async () => {
    expect(await getRunningJobId(LOCAL_TENANT, "camp")).toBeUndefined();
    const id = await createJob(LOCAL_TENANT, "camp");
    expect(await getRunningJobId(LOCAL_TENANT, "camp")).toBe(id);
    expect(await getRunningJobId(LOCAL_TENANT, "other")).toBeUndefined();
    await completeJob(LOCAL_TENANT, id, payload());
    expect(await getRunningJobId(LOCAL_TENANT, "camp")).toBeUndefined();
  });

  test("completeJob records assets.length as done/total", async () => {
    const id = await createJob(LOCAL_TENANT, "camp");
    const result = payload({ assets: [{}, {}] as unknown as JobResult["assets"] });
    await completeJob(LOCAL_TENANT, id, result);
    expect(await getJob(LOCAL_TENANT, id)).toMatchObject({
      status: "completed",
      done: 2,
      total: 2,
      result,
    });
  });

  test("completeJob uses 0/0 when the run halted", async () => {
    const id = await createJob(LOCAL_TENANT, "camp");
    await completeJob(
      LOCAL_TENANT,
      id,
      payload({ halted: true, assets: [{}] as unknown as JobResult["assets"] }),
    );
    expect(await getJob(LOCAL_TENANT, id)).toMatchObject({
      status: "completed",
      done: 0,
      total: 0,
    });
  });

  test("failJob records the error without a result", async () => {
    const id = await createJob(LOCAL_TENANT, "camp");
    await failJob(LOCAL_TENANT, id, "need two products");
    expect(await getJob(LOCAL_TENANT, id)).toEqual({
      status: "failed",
      done: 0,
      total: 0,
      log: null,
      error: "need two products",
    });
  });

  test("a settled job expires after JOB_TTL_MS; a running one does not", async () => {
    vi.useFakeTimers();
    const settled = await createJob(LOCAL_TENANT, "a");
    const running = await createJob(LOCAL_TENANT, "b");
    await completeJob(LOCAL_TENANT, settled, payload());
    vi.advanceTimersByTime(JOB_TTL_MS - 1);
    expect(await getJob(LOCAL_TENANT, settled)).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(await getJob(LOCAL_TENANT, settled)).toBeUndefined();
    expect((await getJob(LOCAL_TENANT, running))?.status).toBe("running");
  });

  test("the store is capped at MAX_JOBS, evicting settled jobs before running ones", async () => {
    const first = await createJob(LOCAL_TENANT, "first");
    await failJob(LOCAL_TENANT, first, "x");
    const kept: string[] = [];
    for (let i = 1; i < MAX_JOBS; i++) kept.push(await createJob(LOCAL_TENANT, `c${i}`));
    // The store is full; the next create must evict one — the settled `first`, not a runner.
    const next = await createJob(LOCAL_TENANT, "next");
    expect(await getJob(LOCAL_TENANT, first)).toBeUndefined();
    for (const id of kept) {
      expect((await getJob(LOCAL_TENANT, id))?.status).toBe("running");
    }
    expect((await getJob(LOCAL_TENANT, next))?.status).toBe("running");
  });

  test("when every job is still running, the facade refuses rather than evicting one", async () => {
    // Pinned the defect, like its counterpart in the store suite: a live run was
    // deleted to make room, losing its lock.
    const oldest = await createJob(LOCAL_TENANT, "c0");
    for (let i = 1; i < MAX_JOBS; i++) await createJob(LOCAL_TENANT, `c${i}`);
    await expect(createJob(LOCAL_TENANT, "overflow")).rejects.toThrow(/job slots are running/);
    expect(await getJob(LOCAL_TENANT, oldest)).toBeDefined();
  });

  test("runJob hands the work a signal that aborts at the run deadline", async () => {
    // R5 - the bound that makes refusing to evict safe (D73). Asserted through
    // the signal the work actually receives, not through the constant: a
    // runJob that forgot to pass one, or passed an already-settled one, fails.
    vi.useFakeTimers();
    try {
      const id = await createJob(LOCAL_TENANT, "camp");
      let seen: AbortSignal | undefined;
      runJob(LOCAL_TENANT, id, async (signal) => {
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
    const id = await createJob(LOCAL_TENANT, "camp");
    runJob(LOCAL_TENANT, id, async () => {
      await completeJob(LOCAL_TENANT, id, payload());
    });
    await vi.waitFor(async () =>
      expect((await getJob(LOCAL_TENANT, id))?.status).toBe("completed"),
    );
  });

  test("runJob marks the job failed when work throws", async () => {
    const id = await createJob(LOCAL_TENANT, "camp");
    runJob(LOCAL_TENANT, id, async () => {
      throw new Error("boom");
    });
    await vi.waitFor(async () => expect((await getJob(LOCAL_TENANT, id))?.status).toBe("failed"));
    expect((await getJob(LOCAL_TENANT, id))?.error).toBe("boom");
  });

  test("runJob uses a generic message when work rejects a non-Error", async () => {
    const id = await createJob(LOCAL_TENANT, "camp");
    runJob(LOCAL_TENANT, id, async () => {
      throw "plain";
    });
    await vi.waitFor(async () =>
      expect((await getJob(LOCAL_TENANT, id))?.error).toBe("Job failed"),
    );
  });

  test("runJob handles failJob storage error by deleting job and unblocking campaign", async () => {
    const id = await createJob(LOCAL_TENANT, "camp");
    const store = (await import("../ports/index.js")).getJobStore(LOCAL_TENANT);
    vi.spyOn(store, "failJob").mockRejectedValueOnce(new Error("disk error"));
    runJob(LOCAL_TENANT, id, async () => {
      throw new Error("work failed");
    });
    await vi.waitFor(async () => expect(await hasRunningJob(LOCAL_TENANT, "camp")).toBe(false));
    expect(await getJob(LOCAL_TENANT, id)).toBeUndefined();
  });

  test("runJob ignores error if deleteJob also fails after failJob failure", async () => {
    const id = await createJob(LOCAL_TENANT, "camp");
    const store = (await import("../ports/index.js")).getJobStore(LOCAL_TENANT);
    vi.spyOn(store, "failJob").mockRejectedValueOnce(new Error("fail error"));
    vi.spyOn(store, "deleteJob").mockRejectedValueOnce(new Error("delete error"));
    runJob(LOCAL_TENANT, id, async () => {
      throw new Error("work failed");
    });
    await new Promise((r) => setTimeout(r, 20));
  });

  test("acquireJob conditionally creates a running job or returns incumbent", async () => {
    const first = await acquireJob(LOCAL_TENANT, "camp");
    expect(first.acquired).toBe(true);
    if (first.acquired) {
      expect(first.jobId).toBeDefined();
      const second = await acquireJob(LOCAL_TENANT, "camp");
      expect(second).toEqual({ acquired: false, runningJobId: first.jobId });
      await completeJob(LOCAL_TENANT, first.jobId, payload());
      const third = await acquireJob(LOCAL_TENANT, "camp");
      expect(third.acquired).toBe(true);
    }
  });

  test("deleteJob removes a job from storage", async () => {
    const id = await createJob(LOCAL_TENANT, "camp");
    expect(await getJob(LOCAL_TENANT, id)).toBeDefined();
    await deleteJob(LOCAL_TENANT, id);
    expect(await getJob(LOCAL_TENANT, id)).toBeUndefined();
  });

  test("runJob heartbeats a lease-backed store while work runs, and stops once it settles (D171 item 3)", async () => {
    vi.useFakeTimers();
    // FsJobStore has no `heartbeat`; a lease-backed store does (PgJobStore, PT-6a).
    // Adding one to the shared instance is enough to flip `isRunRegistry` without
    // standing up a whole fake store.
    const store = (await import("../ports/index.js")).getJobStore(
      LOCAL_TENANT,
    ) as unknown as Record<string, unknown>;
    const heartbeat = vi
      .fn(async () => undefined)
      .mockRejectedValueOnce(new Error("heartbeat write failed"));
    store.heartbeat = heartbeat;
    // Finding 6: a heartbeat failure must not vanish silently — it is logged
    // (no structured logger reaches this module; console.warn is pg-client.ts's
    // own pattern for a background failure nothing awaits).
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const id = await createJob(LOCAL_TENANT, "camp");
      let resolveWork: (() => void) | undefined;
      runJob(
        LOCAL_TENANT,
        id,
        () =>
          new Promise<void>((resolve) => {
            resolveWork = resolve;
          }),
      );
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2);
      expect(heartbeat).toHaveBeenCalledWith(id);
      expect(heartbeat.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`heartbeat failed for job ${id}`));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("heartbeat write failed"));

      resolveWork?.();
      await vi.advanceTimersByTimeAsync(0); // flush the settle so the interval is cleared
      const callsAtSettle = heartbeat.mock.calls.length;
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 3);
      expect(heartbeat.mock.calls.length).toBe(callsAtSettle);
    } finally {
      delete store.heartbeat;
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  test("runJob never heartbeats a store with no lease to extend", async () => {
    vi.useFakeTimers();
    try {
      const id = await createJob(LOCAL_TENANT, "camp");
      runJob(LOCAL_TENANT, id, async () => {
        await new Promise(() => {});
      });
      // No throw, no interval fires against a store with no `heartbeat`: there is
      // nothing to assert a call on, so this only needs to not blow up.
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2);
      expect((await getJob(LOCAL_TENANT, id))?.status).toBe("running");
    } finally {
      vi.useRealTimers();
    }
  });

  test("a non-Error heartbeat rejection is still logged, stringified", async () => {
    vi.useFakeTimers();
    const store = (await import("../ports/index.js")).getJobStore(
      LOCAL_TENANT,
    ) as unknown as Record<string, unknown>;
    // Not an Error on purpose: exercises the `String(error)` fallback.
    const heartbeat = vi.fn(async () => {
      throw "plain string rejection";
    });
    store.heartbeat = heartbeat;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const id = await createJob(LOCAL_TENANT, "camp");
      runJob(LOCAL_TENANT, id, async () => {
        await new Promise(() => {});
      });
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("plain string rejection"));
    } finally {
      delete store.heartbeat;
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  test("runJob does not delete a job whose failJob lost the lease: the reaper already settled it honestly", async () => {
    const store = (await import("../ports/index.js")).getJobStore(LOCAL_TENANT);
    const failSpy = vi
      .spyOn(store, "failJob")
      .mockRejectedValueOnce(new JobLeaseLostError("some-id"));
    // Earlier tests in this file spy on the same shared store without restoring,
    // so `deleteJob`'s call history already carries their calls — compare a delta.
    const deleteSpy = vi.spyOn(store, "deleteJob");
    const callsBefore = deleteSpy.mock.calls.length;
    const id = await createJob(LOCAL_TENANT, "camp");
    runJob(LOCAL_TENANT, id, async () => {
      throw new Error("work failed");
    });
    await vi.waitFor(() => expect(failSpy).toHaveBeenCalled());
    // Give a wrongly-present delete a chance to happen before asserting its absence.
    await new Promise((r) => setTimeout(r, 20));
    expect(deleteSpy.mock.calls.length).toBe(callsBefore);
  });

  test("handle minted survives across separate processes", async () => {
    const id = await createJob(LOCAL_TENANT, "survives");
    const result = spawnSync(
      "yarn",
      [
        "tsx",
        "--input-type=module",
        "-e",
        `import { getJob } from "./apps/api/server/lib/jobs.js";
import { LOCAL_TENANT } from "./apps/api/server/lib/tenant.js";
const job = await getJob(LOCAL_TENANT, process.argv[1]);
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
      const id = await createJob(LOCAL_TENANT, "camp");
      let stillRunning = true;
      runJob(LOCAL_TENANT, id, async () => {
        // Work that ignores the signal entirely — the worst case, and the one
        // the fallback chain actually produces.
        await new Promise(() => {});
        stillRunning = false;
      });
      await vi.advanceTimersByTimeAsync(RUN_DEADLINE_MS + 1);
      await vi.waitFor(async () => expect((await getJob(LOCAL_TENANT, id))?.status).toBe("failed"));
      // The work was not killed — it cannot be — but the slot came back.
      expect(stillRunning).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  afterEach(async () => {
    await resetJobs();
  });

  test("work that finishes first is untouched by the deadline", async () => {
    const id = await createJob(LOCAL_TENANT, "camp");
    runJob(LOCAL_TENANT, id, async () => {
      await completeJob(LOCAL_TENANT, id, payload());
    });
    await vi.waitFor(async () =>
      expect((await getJob(LOCAL_TENANT, id))?.status).toBe("completed"),
    );
  });

  test("a job where deadline fails the job first and work then rejects with JobLeaseLostError stays failed and slot is released", async () => {
    vi.useFakeTimers();
    let unhandled: unknown = undefined;
    const onUnhandled = (err: unknown) => {
      unhandled = err;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const id = await createJob(LOCAL_TENANT, "camp");
      let rejectWork!: (err: Error) => void;
      const workPromise = new Promise<void>((_, reject) => {
        rejectWork = reject;
      });
      runJob(LOCAL_TENANT, id, async () => workPromise);

      await vi.advanceTimersByTimeAsync(RUN_DEADLINE_MS + 1);
      await vi.waitFor(async () =>
        expect((await getJob(LOCAL_TENANT, id))?.status).toBe("failed"),
      );

      rejectWork(new JobLeaseLostError(id));
      await vi.advanceTimersByTimeAsync(10);
      await Promise.resolve();

      expect(unhandled).toBeUndefined();
      expect((await getJob(LOCAL_TENANT, id))?.status).toBe("failed");
      expect(await hasRunningJob(LOCAL_TENANT, "camp")).toBe(false);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      vi.useRealTimers();
    }
  });
});
