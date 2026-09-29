import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  chmodSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PipelineExecutionLog } from "@campaignfoundry/CampaignOrchestration";
import {
  FsJobStore,
  JobCapacityError,
  JOB_TTL_MS,
  MAX_JOBS,
  STALE_GRACE_MS,
  STALE_RUNNING_MESSAGE,
} from "../fs-job-store.js";
import {
  JobLeaseLostError,
  QUEUED_TTL_MS,
  type JobResult,
  type StoredJob,
} from "../job-store.port.js";

const payload = (over: Partial<JobResult> = {}): JobResult => ({
  halted: false,
  assets: [],
  log: new PipelineExecutionLog("camp", () => new Date("2026-01-01T00:00:00.000Z")),
  ...over,
});

describe("FsJobStore", () => {
  let dir: string;
  let store: FsJobStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cf-fs-jobs-"));
    mkdirSync(dir, { recursive: true });
    store = new FsJobStore(dir);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await store.clear();
    rmSync(dir, { recursive: true, force: true });
  });

  test("jobPath is the confined path and rejects a traversing id segment", () => {
    expect(store.jobPath("test-job")).toBe(join(dir, "test-job.json"));
    expect(() => store.jobPath("../escape")).toThrow(/Path escapes the allowed directory/);
  });

  test("getJobsDir returns the directory the store was built with (it has no default, D167)", () => {
    expect(store.getJobsDir()).toBe(dir);
  });

  test("createJob starts running at 0/0 and writes JSON atomically to disk", async () => {
    const id = await store.createJob("camp");
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
    const job = await store.getJob(id);
    expect(job).toEqual({ status: "running", done: 0, total: 0, log: null });

    const raw = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8"));
    expect(raw).toMatchObject({
      id,
      campaignId: "camp",
      job: { status: "running", done: 0, total: 0, log: null },
    });
  });

  test("createJob accepts a custom id", async () => {
    const custom = "11111111-2222-3333-4444-555555555555";
    const id = await store.createJob("camp", custom);
    expect(id).toBe(custom);
    expect(await store.getJob(custom)).toBeDefined();
  });

  test("getJob and getStoredJob return undefined for an unknown id", async () => {
    expect(await store.getJob("00000000-0000-0000-0000-000000000000")).toBeUndefined();
    expect(await store.getStoredJob("00000000-0000-0000-0000-000000000000")).toBeUndefined();
  });

  test("hasRunningJob and getRunningJobId track active campaigns", async () => {
    expect(await store.hasRunningJob("camp")).toBe(false);
    expect(await store.getRunningJobId("camp")).toBeUndefined();

    const id = await store.createJob("camp");
    expect(await store.hasRunningJob("camp")).toBe(true);
    expect(await store.getRunningJobId("camp")).toBe(id);
    expect(await store.hasRunningJob("other")).toBe(false);

    await store.completeJob(id, payload());
    expect(await store.hasRunningJob("camp")).toBe(false);
    expect(await store.getRunningJobId("camp")).toBeUndefined();
  });

  test("completeJob records assets.length and preserves hydrated log", async () => {
    const id = await store.createJob("camp");
    const log = new PipelineExecutionLog("camp", () => new Date("2026-01-01T00:00:00.000Z"));
    log.record("build", "started", "info");
    const result = payload({ assets: [{}, {}] as unknown as JobResult["assets"], log });
    await store.completeJob(id, result);

    const job = await store.getJob(id);
    expect(job).toMatchObject({ status: "completed", done: 2, total: 2 });
    expect(job?.result?.log).toBeInstanceOf(PipelineExecutionLog);
    expect((job?.result?.log as PipelineExecutionLog)?.entries).toHaveLength(1);
  });

  test("completeJob uses 0/0 when the run halted", async () => {
    const id = await store.createJob("camp");
    await store.completeJob(
      id,
      payload({ halted: true, assets: [{}] as unknown as JobResult["assets"] }),
    );
    expect(await store.getJob(id)).toMatchObject({ status: "completed", done: 0, total: 0 });
  });

  test("failJob records the error without a result", async () => {
    const id = await store.createJob("camp");
    await store.failJob(id, "out of memory");
    expect(await store.getJob(id)).toEqual({
      status: "failed",
      done: 0,
      total: 0,
      log: null,
      error: "out of memory",
    });
  });

  test("completeJob and failJob on a nonexistent id are safe no-ops", async () => {
    await expect(store.completeJob("missing-id", payload())).resolves.toBeUndefined();
    await expect(store.failJob("missing-id", "err")).resolves.toBeUndefined();
  });

  test("deleteJob unlinks the job file and cleans up active timers", async () => {
    const id = await store.createJob("camp");
    await store.completeJob(id, payload());
    expect(await store.getJob(id)).toBeDefined();

    await store.deleteJob(id);
    expect(await store.getJob(id)).toBeUndefined();
    // Second delete is a safe no-op on missing file
    await expect(store.deleteJob(id)).resolves.toBeUndefined();
  });

  test("listJobs returns stored jobs ordered by createdAt", async () => {
    const id1 = await store.createJob("camp1");
    await new Promise((r) => setTimeout(r, 5));
    const id2 = await store.createJob("camp2");
    const list = await store.listJobs();
    expect(list.map((j) => j.id)).toEqual([id1, id2]);
  });

  test("multi-instance scope: a job minted by one instance resolves on another instance", async () => {
    const instanceA = new FsJobStore(dir);
    const instanceB = new FsJobStore(dir);

    // Instance A mints the job handle
    const jobId = await instanceA.createJob("shared-campaign");
    expect(jobId).toBeDefined();

    // Instance B resolves the handle (does not 404)
    const resolvedOnB = await instanceB.getJob(jobId);
    expect(resolvedOnB).toEqual({ status: "running", done: 0, total: 0, log: null });

    // Instance A completes the job
    await instanceA.completeJob(jobId, payload({ assets: [{}] as unknown as JobResult["assets"] }));

    // Instance B observes completion
    const completedOnB = await instanceB.getJob(jobId);
    expect(completedOnB?.status).toBe("completed");
    expect(completedOnB?.done).toBe(1);
  });

  test("a settled job expires after JOB_TTL_MS; a running one does not", async () => {
    vi.useFakeTimers();
    const settled = await store.createJob("a");
    const running = await store.createJob("b");
    await store.completeJob(settled, payload());

    vi.advanceTimersByTime(JOB_TTL_MS - 1);
    expect(await store.getJob(settled)).toBeDefined();

    vi.advanceTimersByTime(1);
    expect(await store.getJob(settled)).toBeUndefined();
    expect((await store.getJob(running))?.status).toBe("running");
  });

  test("passive TTL expiration deletes an expired job on getStoredJob", async () => {
    const id = await store.createJob("a");
    await store.completeJob(id, payload());

    // Artificially modify settledAt to be older than JOB_TTL_MS
    const filePath = store.jobPath(id);
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    raw.settledAt = Date.now() - (JOB_TTL_MS + 5_000);
    writeFileSync(filePath, JSON.stringify(raw));

    expect(await store.getJob(id)).toBeUndefined();
  });

  test("the store is capped at MAX_JOBS, evicting settled jobs before running ones", async () => {
    const runner1 = await store.createJob("runner1");
    const settled = await store.createJob("settled");
    await store.failJob(settled, "x");
    const kept: string[] = [runner1];
    for (let i = 2; i < MAX_JOBS; i++) kept.push(await store.createJob(`c${i}`));

    // Store is full; next create evicts settled, not the older runner1
    const next = await store.createJob("next");
    expect(await store.getJob(settled)).toBeUndefined();
    for (const id of kept) {
      expect((await store.getJob(id))?.status).toBe("running");
    }
    expect((await store.getJob(next))?.status).toBe("running");
  });

  test("when every job is still running, the store REFUSES rather than evicting one", async () => {
    // This test used to assert the opposite, and it was pinning the defect: the
    // oldest RUNNER was deleted out from under itself, its lock vanished, and a
    // second Generate for that campaign was admitted to write over it.
    //
    // Refusing is only safe because every run now carries a deadline (R5) - see
    // evictToFit own comment. Without one, a runner never settles and refusing
    // here would wedge the API permanently, which is why D73 puts them in one
    // change.
    const oldest = await store.createJob("c0");
    for (let i = 1; i < MAX_JOBS; i++) await store.createJob(`c${i}`);
    await expect(store.createJob("overflow")).rejects.toThrow(JobCapacityError);
    // The live run is untouched, which is the whole point.
    expect(await store.getJob(oldest)).toBeDefined();
  });

  test("a settled job is still retired to make room", async () => {
    // The capacity refusal must not have turned into "never evict anything".
    const settled = await store.createJob("c0");
    await store.completeJob(settled, { halted: false, assets: [], log: null });
    for (let i = 1; i < MAX_JOBS; i++) await store.createJob(`c${i}`);
    const admitted = await store.createJob("overflow");
    expect(admitted).toBeTruthy();
    expect(await store.getJob(settled)).toBeUndefined();
  });

  test("cleans up the temp file when rename fails during write", async () => {
    // Block destination by creating a directory where destination file would be
    const dummyId = "22222222-2222-2222-2222-222222222222";
    mkdirSync(join(dir, `${dummyId}.json`), { recursive: true });
    await expect(store.createJob("camp", dummyId)).rejects.toThrow();
    expect(readdirSync(dir).some((n) => n.endsWith(".tmp"))).toBe(false);
  });

  test("corrupt non-JSON file is deleted and returns undefined", async () => {
    const corruptId = "33333333-3333-3333-3333-333333333333";
    writeFileSync(join(dir, `${corruptId}.json`), "invalid-json{");
    expect(await store.getJob(corruptId)).toBeUndefined();
  });

  test("missing directory returns empty on listJobs and clear", async () => {
    const missingDirStore = new FsJobStore(join(dir, "does-not-exist"));
    expect(await missingDirStore.listJobs()).toEqual([]);
    await expect(missingDirStore.clear()).resolves.toBeUndefined();
  });

  test("withJobLock serializes execution for the same key", async () => {
    const order: number[] = [];
    const p1 = store.withJobLock("camp", async () => {
      await new Promise((r) => setTimeout(r, 15));
      order.push(1);
    });
    const p2 = store.withJobLock("camp", async () => {
      order.push(2);
    });
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  test("a timer started inside withJobLock queues normally once fired, even though its context still names the key (reentrancy applies only while that acquisition is active)", async () => {
    // Real timers on purpose: AsyncLocalStorage propagates the scheduling
    // context into a real Timeout's callback (that is the whole bug this
    // proves), but vitest's fake-timer clock invokes callbacks as a plain
    // JS call from the test's own context, which never carries the stale
    // store — a fake-timer version of this test would pass whether or not
    // the fix is applied.
    const order: string[] = [];
    let timerRun: Promise<void> = Promise.resolve();

    // Acquire "j", schedule a real setTimeout inside the critical section
    // (mirroring `expireLater`), and release. The timer has not fired yet.
    await store.withJobLock("j", async () => {
      setTimeout(() => {
        timerRun = store.withJobLock("j", async () => {
          order.push("timer");
        });
      }, 10);
    });

    // A second, unrelated holder takes "j" from outside and runs long — long
    // enough that the timer above fires while this holder is still inside
    // its critical section.
    let releaseSecond: () => void = () => {};
    const second = store.withJobLock("j", async () => {
      order.push("second-start");
      await new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
      order.push("second-end");
    });

    // Let the 10ms timer fire while `second` is still parked on its own
    // unresolved promise.
    await new Promise((resolve) => setTimeout(resolve, 40));
    // The timer must not have run inline: it inherited "j" in its context
    // from the FIRST (already-released) acquisition, but that acquisition
    // is no longer active, so it must queue behind `second` like any other
    // genuinely concurrent caller instead of jumping the line.
    expect(order).toEqual(["second-start"]);

    releaseSecond();
    await second;
    await timerRun;
    expect(order).toEqual(["second-start", "second-end", "timer"]);
  });

  test("cached settled job is expired and deleted on getStoredJob when past TTL", async () => {
    const id = await store.createJob("camp");
    await store.failJob(id, "err");
    const cached = (
      store as unknown as { memoryCache: Map<string, { entry: StoredJob; mtimeMs: number }> }
    ).memoryCache.get(id);
    expect(cached).toBeDefined();
    if (cached) cached.entry = { ...cached.entry, settledAt: Date.now() - (JOB_TTL_MS + 1000) };
    expect(await store.getJob(id)).toBeUndefined();
  });

  test("completeJob and failJob after job is settled throw JobLeaseLostError", async () => {
    const id = await store.createJob("camp");
    await store.failJob(id, "first");
    await expect(store.failJob(id, "second")).rejects.toBeInstanceOf(JobLeaseLostError);
    await expect(store.completeJob(id, payload())).rejects.toBeInstanceOf(JobLeaseLostError);
  });

  test("a reused custom id keeps its own retention, not the earlier entry's timer", async () => {
    vi.useFakeTimers();
    await store.createJob("camp", "reused");
    await store.failJob("reused", "first");
    vi.advanceTimersByTime(JOB_TTL_MS - 1000);
    await store.createJob("camp", "reused");
    await store.failJob("reused", "second");
    // The first entry's timer would fire here and delete the replacement.
    vi.advanceTimersByTime(2000);
    expect(await store.getJob("reused")).toMatchObject({ status: "failed", error: "second" });
    vi.useRealTimers();
  });

  test("acquireJob reusing a settled id cancels the earlier entry's pending retention timer", async () => {
    // Unlike the test above, the SECOND run here never settles before the
    // first entry's timer would fire — acquireJob itself, not a second
    // settle, is what has to clear it. This is the gap expireLater's own
    // reuse-clearing (triggered only by settling) does not cover: a caller
    // retries a failed campaign with the same custom id, and the earlier
    // failure's retention timer is still pending.
    vi.useFakeTimers();
    try {
      await store.createJob("camp-a", "reused-after-settle");
      await store.failJob("reused-after-settle", "boom");

      // Before the first entry's JOB_TTL_MS retention timer fires, the id is
      // reused for a fresh run.
      vi.advanceTimersByTime(JOB_TTL_MS - 1000);
      const claim = await store.acquireJob("camp-a", "reused-after-settle");
      expect(claim).toEqual({ acquired: true, jobId: "reused-after-settle" });

      // The FIRST entry's retention timer, left uncancelled, would fire here
      // and delete the second, still-running entry out from under it.
      vi.advanceTimersByTime(2000);

      const stored = await store.getStoredJob("reused-after-settle");
      expect(stored).toBeDefined();
      expect(stored?.job.status).toBe("running");
    } finally {
      vi.useRealTimers();
    }
  });

  test("enqueueJob reusing a settled id cancels the earlier entry's pending retention timer", async () => {
    vi.useFakeTimers();
    try {
      await store.createJob("camp-a", "reused-queue-after-settle");
      await store.completeJob("reused-queue-after-settle", payload());

      vi.advanceTimersByTime(JOB_TTL_MS - 1000);
      const claim = await store.enqueueJob("camp-a", "reused-queue-after-settle");
      expect(claim).toEqual({ acquired: true, jobId: "reused-queue-after-settle" });

      // The completed entry's retention timer, left uncancelled, would fire
      // here and delete the reused (now queued) entry.
      vi.advanceTimersByTime(2000);

      const stored = await store.getStoredJob("reused-queue-after-settle");
      expect(stored).toBeDefined();
      expect(stored?.job.status).toBe("queued");
    } finally {
      vi.useRealTimers();
    }
  });

  test("expireLater catches deleteJob rejection without unhandled rejection", async () => {
    vi.useFakeTimers();
    const id = await store.createJob("camp");
    vi.spyOn(store, "deleteJob").mockRejectedValueOnce(new Error("unlink error"));
    await store.failJob(id, "err");
    vi.advanceTimersByTime(JOB_TTL_MS);
    vi.useRealTimers();
  });

  test("expireQueuedLater catches a getStoredJob rejection without unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    vi.useFakeTimers();
    try {
      const enq = await store.enqueueJob("camp");
      expect(enq.acquired).toBe(true);
      if (!enq.acquired) return;
      const read = vi.spyOn(store, "getStoredJob").mockRejectedValueOnce(new Error("read error"));
      await vi.advanceTimersByTimeAsync(QUEUED_TTL_MS + 1);
      expect(read).toHaveBeenCalledWith(enq.jobId);
      expect(unhandled).toEqual([]);
    } finally {
      vi.useRealTimers();
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("acquireJob conditionally creates a new job or returns running incumbent", async () => {
    const first = await store.acquireJob("camp");
    expect(first.acquired).toBe(true);
    if (first.acquired) {
      expect(first.jobId).toBeDefined();
      const second = await store.acquireJob("camp");
      expect(second).toEqual({ acquired: false, runningJobId: first.jobId });
      // createJob returns the running id if job is already running
      const third = await store.createJob("camp");
      expect(third).toBe(first.jobId);
    }
  });

  test("evictToFit loops while capacity exceeds MAX_JOBS", async () => {
    // Manually create MAX_JOBS + 2 files
    for (let i = 0; i < MAX_JOBS + 2; i++) {
      const entry: StoredJob = {
        id: `overflow-${i}`,
        campaignId: `c-${i}`,
        job: { status: i < 3 ? "completed" : "running", done: 0, total: 0, log: null },
        createdAt: Date.now() + i,
        seq: i,
      };
      writeFileSync(store.jobPath(`overflow-${i}`), JSON.stringify(entry));
    }
    const newId = await store.createJob("brand-new");
    expect(newId).toBeDefined();
    const remaining = await store.listJobs();
    expect(remaining.length).toBeLessThanOrEqual(MAX_JOBS);
  });

  test("completeJob and failJob do nothing if job does not exist", async () => {
    await expect(store.completeJob("missing", payload())).resolves.toBeUndefined();
    await expect(store.failJob("missing", "err")).resolves.toBeUndefined();
  });

  test("clear deletes .json and .tmp files but ignores other files", async () => {
    writeFileSync(join(dir, "extra.txt"), "keep");
    writeFileSync(join(dir, "temp.tmp"), "temp");
    await store.createJob("camp");
    await store.clear();
    expect(readdirSync(dir)).toEqual(["extra.txt"]);
  });

  test("listJobs sorts by createdAt, seq, and id", async () => {
    const now = Date.now();
    const entry1: StoredJob = {
      id: "b",
      campaignId: "c",
      job: { status: "running", done: 0, total: 0, log: null },
      createdAt: now,
      seq: 1,
    };
    const entry2: StoredJob = {
      id: "a",
      campaignId: "c",
      job: { status: "running", done: 0, total: 0, log: null },
      createdAt: now,
      seq: 1,
    };
    const entry3: StoredJob = {
      id: "c",
      campaignId: "c",
      job: { status: "running", done: 0, total: 0, log: null },
      createdAt: now - 1000,
      seq: 1,
    };
    const entry4: StoredJob = {
      id: "d",
      campaignId: "c",
      job: { status: "running", done: 0, total: 0, log: null },
      createdAt: now,
      seq: 2,
    };

    writeFileSync(join(dir, "b.json"), JSON.stringify(entry1));
    writeFileSync(join(dir, "a.json"), JSON.stringify(entry2));
    writeFileSync(join(dir, "c.json"), JSON.stringify(entry3));
    writeFileSync(join(dir, "d.json"), JSON.stringify(entry4));

    const list = await store.listJobs();
    expect(list.map((j) => j.id)).toEqual(["c", "a", "b", "d"]);
  });

  test("listJobs skips files that cannot be parsed", async () => {
    writeFileSync(join(dir, "invalid.json"), "{broken");
    const id = await store.createJob("camp");
    const list = await store.listJobs();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(id);
  });

  const canDenyRead = process.platform !== "win32" && process.getuid?.() !== 0;

  test.skipIf(!canDenyRead)(
    "getStoredJob, deleteJob, listJobs, clear rethrow non-ENOENT errors",
    async () => {
      const id = await store.createJob("camp");
      (store as unknown as { memoryCache: Map<string, unknown> }).memoryCache.clear();

      chmodSync(dir, 0o000);
      try {
        await expect(store.getStoredJob(id)).rejects.toMatchObject({ code: "EACCES" });
        await expect(store.listJobs()).rejects.toMatchObject({ code: "EACCES" });
        await expect(store.clear()).rejects.toMatchObject({ code: "EACCES" });
        await expect(store.deleteJob(id)).rejects.toMatchObject({ code: "EACCES" });
      } finally {
        chmodSync(dir, 0o755);
      }
    },
  );

  test.skipIf(!canDenyRead)(
    "getStoredJob rethrows when readFile fails with non-ENOENT error",
    async () => {
      const id = await store.createJob("camp");
      (store as unknown as { memoryCache: Map<string, unknown> }).memoryCache.clear();
      const filePath = store.jobPath(id);
      chmodSync(filePath, 0o000);
      try {
        await expect(store.getStoredJob(id)).rejects.toMatchObject({ code: "EACCES" });
      } finally {
        chmodSync(filePath, 0o644);
      }
    },
  );

  test("getStoredJob returns undefined when readFile encounters ENOENT", async () => {
    const id = await store.createJob("camp");
    (store as unknown as { memoryCache: Map<string, unknown> }).memoryCache.clear();
    const realPath = store.jobPath(id);
    let calls = 0;
    vi.spyOn(store, "jobPath").mockImplementation(() => {
      calls++;
      if (calls === 1) return realPath;
      return join(dir, "vanished.json");
    });
    expect(await store.getStoredJob(id)).toBeUndefined();
  });

  test.skipIf(!canDenyRead)(
    "writeJobEntry cleans up and throws when directory write fails",
    async () => {
      chmodSync(dir, 0o555);
      try {
        await expect(store.createJob("camp")).rejects.toMatchObject({ code: "EACCES" });
      } finally {
        chmodSync(dir, 0o755);
      }
    },
  );

  test("enqueueJob creates a queued job and returns { acquired: true, jobId }", async () => {
    const res = await store.enqueueJob("camp");
    expect(res.acquired).toBe(true);
    if (!res.acquired) return;
    const stored = await store.getStoredJob(res.jobId);
    expect(stored?.job.status).toBe("queued");
  });

  test("a queued row blocks a second enqueueJob and acquireJob", async () => {
    const first = await store.enqueueJob("camp");
    expect(first.acquired).toBe(true);
    if (!first.acquired) return;

    const second = await store.enqueueJob("camp");
    expect(second.acquired).toBe(false);
    if (second.acquired) return;
    expect(second.runningJobId).toBe(first.jobId);

    const acq = await store.acquireJob("camp");
    expect(acq.acquired).toBe(false);
    if (acq.acquired) return;
    expect(acq.runningJobId).toBe(first.jobId);
  });

  test("a running row blocks enqueueJob", async () => {
    const acq = await store.acquireJob("camp");
    expect(acq.acquired).toBe(true);
    if (!acq.acquired) return;

    const enq = await store.enqueueJob("camp");
    expect(enq.acquired).toBe(false);
    if (enq.acquired) return;
    expect(enq.runningJobId).toBe(acq.jobId);
  });

  test("startQueuedJob moves a queued job to running and duplicate delivery returns false", async () => {
    const enq = await store.enqueueJob("camp");
    expect(enq.acquired).toBe(true);
    if (!enq.acquired) return;

    const started = await store.startQueuedJob(enq.jobId);
    expect(started).toBe(true);

    const stored = await store.getStoredJob(enq.jobId);
    expect(stored?.job.status).toBe("running");

    // Second call returns false (already running)
    const second = await store.startQueuedJob(enq.jobId);
    expect(second).toBe(false);

    // Unknown id returns false
    expect(await store.startQueuedJob("00000000-0000-0000-0000-000000000000")).toBe(false);
  });

  test("startQueuedJob still starts a queued row that was never registered with a queued-expiry timer", async () => {
    // A row can be "queued" in storage with no live timer for it — a fresh
    // FsJobStore over the same directory after a process restart, or (as
    // here) any write that did not go through enqueueJob. startQueuedJob must
    // not assume the bookkeeping map always has an entry to clear.
    const id = "cold-queued-id";
    const entry: StoredJob = {
      id,
      campaignId: "camp",
      job: { status: "queued", done: 0, total: 0, log: null },
      createdAt: Date.now(),
      seq: 0,
    };
    writeFileSync(store.jobPath(id), JSON.stringify(entry), "utf8");

    expect(await store.startQueuedJob(id)).toBe(true);
    expect((await store.getJob(id))?.status).toBe("running");
  });

  test("a reused queued id clears the earlier queued-expiry timer", async () => {
    vi.useFakeTimers();
    try {
      const first = await store.enqueueJob("camp-a", "reused-queued");
      expect(first.acquired).toBe(true);

      // Same custom id, a different campaign: the incumbent check is per
      // campaignId, so this succeeds while "reused-queued" is still queued
      // for camp-a, overwrites its entry and re-registers its queued-expiry
      // timer — the earlier timer must be cleared first, the same rule
      // `expireLater` already follows for a settled row's retention timer.
      const second = await store.enqueueJob("camp-b", "reused-queued");
      expect(second.acquired).toBe(true);

      await vi.advanceTimersByTimeAsync(QUEUED_TTL_MS + 1);

      const stored = await store.getStoredJob("reused-queued");
      expect(stored?.campaignId).toBe("camp-b");
      expect(stored?.job.status).toBe("failed");
    } finally {
      vi.useRealTimers();
    }
  });

  test("queued job expires and is marked failed after QUEUED_TTL_MS", async () => {
    vi.useFakeTimers();
    try {
      const enq = await store.enqueueJob("camp");
      expect(enq.acquired).toBe(true);
      if (!enq.acquired) return;

      await vi.advanceTimersByTimeAsync(QUEUED_TTL_MS + 1);

      const stored = await store.getStoredJob(enq.jobId);
      expect(stored?.job.status).toBe("failed");
      expect(stored?.job.error).toMatch(/expired|timed out/i);
    } finally {
      vi.useRealTimers();
    }
  });

  test("getStoredJob marks an expired queued job as failed on a cold disk read", async () => {
    // The TTL timer above fires and rewrites the entry itself, so it never
    // exercises getStoredJob's OWN staleness check on a read that finds
    // nothing cached — the path a second process (a fresh store over the same
    // dir) or a cache-evicted read takes. Backdating createdAt on disk leaves
    // the queued-expiry timer pending in real time (it never fires during
    // this test), so only that on-read check can be what marks it failed.
    const enq = await store.enqueueJob("camp");
    expect(enq.acquired).toBe(true);
    if (!enq.acquired) return;

    const raw = JSON.parse(readFileSync(store.jobPath(enq.jobId), "utf8")) as StoredJob;
    writeFileSync(
      store.jobPath(enq.jobId),
      JSON.stringify({ ...raw, createdAt: Date.now() - QUEUED_TTL_MS - 1 }),
      "utf8",
    );
    (store as unknown as { memoryCache: Map<string, unknown> }).memoryCache.clear();

    const stored = await store.getStoredJob(enq.jobId);
    expect(stored?.job.status).toBe("failed");
    expect(stored?.job.error).toMatch(/expired/i);
  });

  test("a stale queued row's on-read expiry is what lets its campaign be re-enqueued (finding 4)", async () => {
    // Same shape as "getStoredJob marks an expired queued job as failed on a
    // cold disk read" above, but the point here is `enqueueJob`, not
    // `getStoredJob` directly: `enqueueJob` finds the incumbent through
    // `getRunningJobId` -> `listJobs` -> `getStoredJob` for each entry, so the
    // SAME on-read staleness check has to run inside that path too. If it did
    // not, the stale row would still read as "queued" there and block a
    // second `enqueueJob` for the same campaign with `acquired: false`.
    const enq = await store.enqueueJob("camp");
    expect(enq.acquired).toBe(true);
    if (!enq.acquired) return;

    const raw = JSON.parse(readFileSync(store.jobPath(enq.jobId), "utf8")) as StoredJob;
    writeFileSync(
      store.jobPath(enq.jobId),
      JSON.stringify({ ...raw, createdAt: Date.now() - QUEUED_TTL_MS - 1 }),
      "utf8",
    );
    (store as unknown as { memoryCache: Map<string, unknown> }).memoryCache.clear();

    const retry = await store.enqueueJob("camp");
    expect(retry).toEqual({ acquired: true, jobId: expect.any(String) });
    expect(retry.acquired && retry.jobId).not.toBe(enq.jobId);

    const stale = await store.getStoredJob(enq.jobId);
    expect(stale?.job.status).toBe("failed");
  });

  test("deleteJob clears a still-pending queued-expiry timer", async () => {
    const enq = await store.enqueueJob("camp");
    expect(enq.acquired).toBe(true);
    if (!enq.acquired) return;

    // The queued TTL timer set by enqueueJob is still pending (real time,
    // never advanced): deleting the job here must clear it rather than leave
    // it to fire later against an id that no longer exists.
    await store.deleteJob(enq.jobId);
    expect(await store.getJob(enq.jobId)).toBeUndefined();
  });

  test("a job queued long ago but started just now is not reaped (startedAt, not createdAt, sets the deadline)", async () => {
    vi.useFakeTimers();
    try {
      const enq = await store.enqueueJob("campaign-queued-long-ago");
      expect(enq.acquired).toBe(true);
      if (!enq.acquired) return;

      // Backdate createdAt to look like it sat in the queue for 9 minutes —
      // long, but still under QUEUED_TTL_MS (10 min), so the queued-expiry
      // check does not fire first and mask what this test is proving.
      const raw = JSON.parse(readFileSync(store.jobPath(enq.jobId), "utf8")) as StoredJob;
      writeFileSync(
        store.jobPath(enq.jobId),
        JSON.stringify({ ...raw, createdAt: Date.now() - 9 * 60_000 }),
        "utf8",
      );
      (store as unknown as { memoryCache: Map<string, unknown> }).memoryCache.clear();

      // The run starts now: startQueuedJob must set startedAt to the current
      // time, independent of the ancient createdAt.
      expect(await store.startQueuedJob(enq.jobId)).toBe(true);

      // Advance to just under the stale-running threshold MEASURED FROM
      // startedAt. Measured from createdAt instead, this point is
      // 9min + (threshold - 1ms) — well past the threshold — so a
      // createdAt-based check would already have reaped it here.
      vi.advanceTimersByTime(JOB_TTL_MS + STALE_GRACE_MS - 1);

      const stored = await store.getStoredJob(enq.jobId);
      expect(stored?.job.status).toBe("running");
      expect(stored?.job.error).toBeUndefined();
      expect(stored?.settledAt).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a stale running job is reaped on restart and the campaign can acquire again", async () => {
    vi.useFakeTimers();
    try {
      // Create a running job
      const id = await store.createJob("campaign-stale");
      expect(await store.getRunningJobId("campaign-stale")).toBe(id);

      // Backdate both createdAt and startedAt to be older than RUN_DEADLINE_MS + STALE_GRACE_MS
      // RUN_DEADLINE_MS === JOB_TTL_MS (10 minutes), STALE_GRACE_MS = 60 seconds
      const raw = JSON.parse(readFileSync(store.jobPath(id), "utf8")) as StoredJob;
      writeFileSync(
        store.jobPath(id),
        JSON.stringify({
          ...raw,
          createdAt: Date.now() - (JOB_TTL_MS + STALE_GRACE_MS + 1000),
          startedAt: Date.now() - (JOB_TTL_MS + STALE_GRACE_MS + 1000),
        }),
        "utf8",
      );
      // Clear cache so the stale read goes to disk
      (store as unknown as { memoryCache: Map<string, unknown> }).memoryCache.clear();

      // Simulate a restart: new store instance on the same directory
      const restartedStore = new FsJobStore(dir);

      // FIXED: the stale running job is reaped, campaign can acquire again
      const runningId = await restartedStore.getRunningJobId("campaign-stale");
      expect(runningId).toBeUndefined();

      // The job should now read as failed with the stale running message
      const stored = await restartedStore.getStoredJob(id);
      expect(stored).toBeDefined();
      expect(stored?.job.status).toBe("failed");
      expect(stored?.job.error).toBe(STALE_RUNNING_MESSAGE);
      expect(stored?.settledAt).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a stale running job reads as failed with the exact message and settledAt set", async () => {
    vi.useFakeTimers();
    try {
      const id = await store.createJob("campaign-stale-read");
      // Backdate createdAt to be stale
      const raw = JSON.parse(readFileSync(store.jobPath(id), "utf8")) as StoredJob;
      writeFileSync(
        store.jobPath(id),
        JSON.stringify({
          ...raw,
          createdAt: Date.now() - (JOB_TTL_MS + STALE_GRACE_MS + 1000),
          startedAt: Date.now() - (JOB_TTL_MS + STALE_GRACE_MS + 1000),
        }),
        "utf8",
      );
      (store as unknown as { memoryCache: Map<string, unknown> }).memoryCache.clear();

      const stored = await store.getStoredJob(id);
      expect(stored).toBeDefined();
      expect(stored?.job.status).toBe("failed");
      expect(stored?.job.error).toBe(STALE_RUNNING_MESSAGE);
      expect(stored?.job.done).toBe(0);
      expect(stored?.job.total).toBe(0);
      expect(stored?.job.log).toBeNull();
      expect(stored?.settledAt).toBeDefined();
      expect(typeof stored?.settledAt).toBe("number");
      // settledAt should be "now" (within fake timer)
      expect(stored?.settledAt).toBeGreaterThan(Date.now() - 1000);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a stale running job is rewritten on disk and a third store instance reads it as failed", async () => {
    vi.useFakeTimers();
    try {
      const id = await store.createJob("campaign-stale-disk");
      // Backdate createdAt to be stale
      const raw = JSON.parse(readFileSync(store.jobPath(id), "utf8")) as StoredJob;
      writeFileSync(
        store.jobPath(id),
        JSON.stringify({
          ...raw,
          createdAt: Date.now() - (JOB_TTL_MS + STALE_GRACE_MS + 1000),
          startedAt: Date.now() - (JOB_TTL_MS + STALE_GRACE_MS + 1000),
        }),
        "utf8",
      );
      (store as unknown as { memoryCache: Map<string, unknown> }).memoryCache.clear();

      // First store instance reads and reaps
      const stored1 = await store.getStoredJob(id);
      expect(stored1?.job.status).toBe("failed");
      expect(stored1?.job.error).toBe(STALE_RUNNING_MESSAGE);

      // Second store instance (simulating another process) reads the rewritten file
      const store2 = new FsJobStore(dir);
      const stored2 = await store2.getStoredJob(id);
      expect(stored2).toBeDefined();
      expect(stored2?.job.status).toBe("failed");
      expect(stored2?.job.error).toBe(STALE_RUNNING_MESSAGE);
      expect(stored2?.settledAt).toBeDefined();

      // Third store instance also reads it as failed
      const store3 = new FsJobStore(dir);
      const stored3 = await store3.getStoredJob(id);
      expect(stored3?.job.status).toBe("failed");
      expect(stored3?.job.error).toBe(STALE_RUNNING_MESSAGE);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a running job just under the stale threshold is untouched", async () => {
    vi.useFakeTimers();
    try {
      const id = await store.createJob("campaign-not-stale");
      // Backdate createdAt to be JUST under the threshold (threshold - 1ms)
      const raw = JSON.parse(readFileSync(store.jobPath(id), "utf8")) as StoredJob;
      writeFileSync(
        store.jobPath(id),
        JSON.stringify({
          ...raw,
          createdAt: Date.now() - (JOB_TTL_MS + STALE_GRACE_MS - 1),
          startedAt: Date.now() - (JOB_TTL_MS + STALE_GRACE_MS - 1),
        }),
        "utf8",
      );
      (store as unknown as { memoryCache: Map<string, unknown> }).memoryCache.clear();

      const stored = await store.getStoredJob(id);
      expect(stored).toBeDefined();
      expect(stored?.job.status).toBe("running");
      expect(stored?.job.error).toBeUndefined();
      expect(stored?.settledAt).toBeUndefined();
      // Running job should still be returned by getRunningJobId
      expect(await store.getRunningJobId("campaign-not-stale")).toBe(id);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a running job younger than the stale threshold survives a read by a fresh store instance", async () => {
    vi.useFakeTimers();
    try {
      // Create a running job and advance time to just under the threshold
      const id = await store.createJob("camp-young");
      vi.advanceTimersByTime(JOB_TTL_MS + STALE_GRACE_MS - 1);

      // A fresh store instance should read it as still running (not reaped)
      const freshStore = new FsJobStore(dir);
      const stored = await freshStore.getStoredJob(id);
      expect(stored?.job.status).toBe("running");
      expect(stored?.job.error).toBeUndefined();
      expect(stored?.settledAt).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("two concurrent reads of a stale running job rewrite it once (idempotent)", async () => {
    vi.useFakeTimers();
    try {
      const id = await store.createJob("campaign-concurrent");
      // Backdate createdAt to be stale
      const raw = JSON.parse(readFileSync(store.jobPath(id), "utf8")) as StoredJob;
      writeFileSync(
        store.jobPath(id),
        JSON.stringify({
          ...raw,
          createdAt: Date.now() - (JOB_TTL_MS + STALE_GRACE_MS + 1000),
          startedAt: Date.now() - (JOB_TTL_MS + STALE_GRACE_MS + 1000),
        }),
        "utf8",
      );
      (store as unknown as { memoryCache: Map<string, unknown> }).memoryCache.clear();

      // The job lock (reapStaleRunningLocked), not luck, is what makes this
      // idempotent: spy on the actual write so two racing reaps can't be
      // mistaken for two writes that happened to agree.
      const writeSpy = vi.spyOn(
        store as unknown as { writeJobEntry: (entry: StoredJob) => Promise<void> },
        "writeJobEntry",
      );

      // Two concurrent reads
      const [stored1, stored2] = await Promise.all([
        store.getStoredJob(id),
        store.getStoredJob(id),
      ]);

      // Both should see the job as failed with the same message
      expect(stored1?.job.status).toBe("failed");
      expect(stored1?.job.error).toBe(STALE_RUNNING_MESSAGE);
      expect(stored2?.job.status).toBe("failed");
      expect(stored2?.job.error).toBe(STALE_RUNNING_MESSAGE);
      expect(writeSpy).toHaveBeenCalledTimes(1);

      // The file on disk should have the failed status (last write wins, but content is same)
      const disk = JSON.parse(readFileSync(store.jobPath(id), "utf8")) as StoredJob;
      expect(disk.job.status).toBe("failed");
      expect(disk.job.error).toBe(STALE_RUNNING_MESSAGE);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a job completed between the stale read and the reap stays completed", async () => {
    vi.useFakeTimers();
    try {
      const id = await store.createJob("campaign-race-complete");
      // `store` (instance A) caches the running entry.
      const cachedFirst = await store.getStoredJob(id);
      expect(cachedFirst?.job.status).toBe("running");
      const cache = (
        store as unknown as {
          memoryCache: Map<string, { entry: StoredJob; mtimeMs: number }>;
        }
      ).memoryCache;
      const cachedMtime = cache.get(id)!.mtimeMs;

      // A different (fresh) store instance completes the job right away —
      // simulating another process/instance finishing the run — while it is
      // nowhere near stale, so its own read does not reap it first and its
      // JOB_TTL_MS retention timer is nowhere near firing yet.
      const storeB = new FsJobStore(dir);
      await storeB.completeJob(id, payload());

      // Make A's CACHED copy look stale without advancing the clock (which
      // would also fire storeB's real completion-retention timer): splice
      // an old startedAt into the entry object A already cached. This is
      // exactly what a real stale cache entry looks like once enough time
      // has actually passed.
      const staleCached = cache.get(id)!;
      cache.set(id, {
        entry: {
          ...staleCached.entry,
          startedAt: Date.now() - (JOB_TTL_MS + STALE_GRACE_MS + 1000),
        },
        mtimeMs: cachedMtime,
      });

      // Force the file's mtime back to what A cached: the coarse-mtime
      // scenario where A's cheap freshness check says "still fresh" and it
      // would read straight from its (now-stale) cache. The re-read inside
      // reapStaleRunningLocked is what still catches the completion even
      // when the mtime check alone could not.
      utimesSync(store.jobPath(id), new Date(cachedMtime), new Date(cachedMtime));

      const stored = await store.getStoredJob(id);
      expect(stored?.job.status).toBe("completed");
    } finally {
      vi.useRealTimers();
    }
  });

  test("a second read after a reap answers from the cache without re-reading disk", async () => {
    vi.useFakeTimers();
    try {
      const id = await store.createJob("campaign-cache-after-reap");
      const raw = JSON.parse(readFileSync(store.jobPath(id), "utf8")) as StoredJob;
      writeFileSync(
        store.jobPath(id),
        JSON.stringify({
          ...raw,
          createdAt: Date.now() - (JOB_TTL_MS + STALE_GRACE_MS + 1000),
          startedAt: Date.now() - (JOB_TTL_MS + STALE_GRACE_MS + 1000),
        }),
        "utf8",
      );
      (store as unknown as { memoryCache: Map<string, unknown> }).memoryCache.clear();

      const first = await store.getStoredJob(id);
      expect(first?.job.status).toBe("failed");

      // writeJobEntry (fs-job-store.ts) sets memoryCache on every write,
      // including the reaper's rewrite — so a second read must answer from
      // that cache alone and never touch disk again.
      const diskRead = vi.spyOn(
        store as unknown as { readEntryFromDisk: (id: string) => Promise<unknown> },
        "readEntryFromDisk",
      );

      const second = await store.getStoredJob(id);
      expect(second?.job.status).toBe("failed");
      expect(second?.job.error).toBe(STALE_RUNNING_MESSAGE);
      expect(diskRead).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("reapStaleRunningLocked returns undefined when the fresh read finds the file gone", async () => {
    vi.useFakeTimers();
    try {
      const id = await store.createJob("campaign-vanished-during-reap");
      const first = await store.getStoredJob(id);
      expect(first?.job.status).toBe("running");

      const cache = (
        store as unknown as {
          memoryCache: Map<string, { entry: StoredJob; mtimeMs: number }>;
        }
      ).memoryCache;
      const cached = cache.get(id)!;
      // Make the cached copy look stale without advancing the clock (same
      // splice-in technique as the completed-during-reap race test above).
      cache.set(id, {
        entry: { ...cached.entry, startedAt: Date.now() - (JOB_TTL_MS + STALE_GRACE_MS + 1000) },
        mtimeMs: cached.mtimeMs,
      });

      // Simulate the file having vanished by the time the reap's fresh read
      // runs (deleted by a concurrent process or eviction between the cache
      // check and the lock).
      vi.spyOn(
        store as unknown as { readEntryFromDisk: (id: string) => Promise<StoredJob | undefined> },
        "readEntryFromDisk",
      ).mockResolvedValueOnce(undefined);

      const stored = await store.getStoredJob(id);
      expect(stored).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("eviction may now retire a reaped job", async () => {
    vi.useFakeTimers();
    try {
      // Create a stale running job that will be reaped
      const staleId = await store.createJob("campaign-stale-evict");
      const raw = JSON.parse(readFileSync(store.jobPath(staleId), "utf8")) as StoredJob;
      writeFileSync(
        store.jobPath(staleId),
        JSON.stringify({
          ...raw,
          createdAt: Date.now() - (JOB_TTL_MS + STALE_GRACE_MS + 1000),
          startedAt: Date.now() - (JOB_TTL_MS + STALE_GRACE_MS + 1000),
        }),
        "utf8",
      );
      (store as unknown as { memoryCache: Map<string, unknown> }).memoryCache.clear();

      // Read it to trigger reaping
      const reaped = await store.getStoredJob(staleId);
      expect(reaped?.job.status).toBe("failed");

      // Fill the store with MAX_JOBS - 1 running jobs
      const runningIds: string[] = [];
      for (let i = 0; i < MAX_JOBS - 1; i++) {
        runningIds.push(await store.createJob(`runner-${i}`));
      }

      // Store should have MAX_JOBS jobs (MAX_JOBS - 1 running + 1 reaped failed)
      let jobs = await store.listJobs();
      expect(jobs.length).toBe(MAX_JOBS);

      // Creating one more job should evict the reaped (settled) job, not a running one
      const newId = await store.createJob("new-campaign");
      expect(newId).toBeDefined();

      jobs = await store.listJobs();
      expect(jobs.length).toBe(MAX_JOBS);
      expect(await store.getJob(staleId)).toBeUndefined(); // Reaped job evicted
      for (const rid of runningIds) {
        expect((await store.getJob(rid))?.status).toBe("running");
      }
      expect((await store.getJob(newId))?.status).toBe("running");
    } finally {
      vi.useRealTimers();
    }
  });

  test("RUN_DEADLINE_MS equals JOB_TTL_MS (pin)", async () => {
    // This test ensures that if either constant changes, the relationship is noticed.
    // RUN_DEADLINE_MS is defined as JOB_TTL_MS in lib/jobs.ts.
    const { RUN_DEADLINE_MS } = await import("../../jobs.js");
    expect(RUN_DEADLINE_MS).toBe(JOB_TTL_MS);
  });

  test("progressJob on a stale running job reaps it and does not update progress", async () => {
    vi.useFakeTimers();
    try {
      const id = await store.createJob("campaign-stale-progress");
      // Backdate createdAt to be stale
      const raw = JSON.parse(readFileSync(store.jobPath(id), "utf8")) as StoredJob;
      writeFileSync(
        store.jobPath(id),
        JSON.stringify({
          ...raw,
          createdAt: Date.now() - (JOB_TTL_MS + STALE_GRACE_MS + 1000),
          startedAt: Date.now() - (JOB_TTL_MS + STALE_GRACE_MS + 1000),
        }),
        "utf8",
      );
      (store as unknown as { memoryCache: Map<string, unknown> }).memoryCache.clear();

      // progressJob should reap the stale job and return without updating progress
      await store.progressJob(id, 5, 10);

      // The job should now be failed, not running with updated progress
      const stored = await store.getStoredJob(id);
      expect(stored?.job.status).toBe("failed");
      expect(stored?.job.error).toBe(STALE_RUNNING_MESSAGE);
      expect(stored?.job.done).toBe(0);
      expect(stored?.job.total).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("completeJob on a stale running job reaps it and throws JobLeaseLostError", async () => {
    vi.useFakeTimers();
    try {
      const id = await store.createJob("campaign-stale-complete");
      // Backdate createdAt to be stale
      const raw = JSON.parse(readFileSync(store.jobPath(id), "utf8")) as StoredJob;
      writeFileSync(
        store.jobPath(id),
        JSON.stringify({
          ...raw,
          createdAt: Date.now() - (JOB_TTL_MS + STALE_GRACE_MS + 1000),
          startedAt: Date.now() - (JOB_TTL_MS + STALE_GRACE_MS + 1000),
        }),
        "utf8",
      );
      (store as unknown as { memoryCache: Map<string, unknown> }).memoryCache.clear();

      // completeJob should reap the stale job and throw JobLeaseLostError
      await expect(store.completeJob(id, payload())).rejects.toBeInstanceOf(JobLeaseLostError);

      // The job should now be failed
      const stored = await store.getStoredJob(id);
      expect(stored?.job.status).toBe("failed");
      expect(stored?.job.error).toBe(STALE_RUNNING_MESSAGE);
    } finally {
      vi.useRealTimers();
    }
  });

  test("failJob on a stale running job reaps it and throws JobLeaseLostError", async () => {
    vi.useFakeTimers();
    try {
      const id = await store.createJob("campaign-stale-fail");
      // Backdate createdAt to be stale
      const raw = JSON.parse(readFileSync(store.jobPath(id), "utf8")) as StoredJob;
      writeFileSync(
        store.jobPath(id),
        JSON.stringify({
          ...raw,
          createdAt: Date.now() - (JOB_TTL_MS + STALE_GRACE_MS + 1000),
          startedAt: Date.now() - (JOB_TTL_MS + STALE_GRACE_MS + 1000),
        }),
        "utf8",
      );
      (store as unknown as { memoryCache: Map<string, unknown> }).memoryCache.clear();

      // failJob should reap the stale job and throw JobLeaseLostError
      await expect(store.failJob(id, "error")).rejects.toBeInstanceOf(JobLeaseLostError);

      // The job should now be failed (with the stale running message, not the provided error)
      const stored = await store.getStoredJob(id);
      expect(stored?.job.status).toBe("failed");
      expect(stored?.job.error).toBe(STALE_RUNNING_MESSAGE);
    } finally {
      vi.useRealTimers();
    }
  });

  test("progressJob updates progress on a running job", async () => {
    const id = await store.createJob("campaign-progress");
    await store.progressJob(id, 5, 10);
    const stored = await store.getStoredJob(id);
    expect(stored?.job.done).toBe(5);
    expect(stored?.job.total).toBe(10);
    expect(stored?.job.status).toBe("running");
  });

  test("getStoredJob reaps a stale running job from cache", async () => {
    vi.useFakeTimers();
    try {
      const id = await store.createJob("campaign-cached-stale");
      // Read once to populate cache with current time
      expect((await store.getStoredJob(id))?.job.status).toBe("running");

      // Advance time past the stale threshold
      vi.advanceTimersByTime(JOB_TTL_MS + STALE_GRACE_MS + 1000);

      // Second read should reap from cache (cache has the original createdAt, but time has advanced)
      const stored = await store.getStoredJob(id);
      expect(stored?.job.status).toBe("failed");
      expect(stored?.job.error).toBe(STALE_RUNNING_MESSAGE);
    } finally {
      vi.useRealTimers();
    }
  });

  test("progressJob on non-existent job is a no-op", async () => {
    await expect(
      store.progressJob("00000000-0000-0000-0000-000000000000", 5, 10),
    ).resolves.toBeUndefined();
  });
});
