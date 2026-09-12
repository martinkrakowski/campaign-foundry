import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PipelineExecutionLog } from "@campaignfoundry/CampaignOrchestration";
import { FsJobStore, JOB_TTL_MS, MAX_JOBS } from "../fs-job-store.js";
import type { JobResult, StoredJob } from "../job-store.port.js";

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

  test("getJobsDir returns the configured directory or default outputRoot", () => {
    expect(store.getJobsDir()).toBe(dir);
    const defaultStore = new FsJobStore();
    expect(defaultStore.getJobsDir()).toMatch(/\/output\/jobs$/);
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
    await store.completeJob(id, payload({ halted: true, assets: [{}] as unknown as JobResult["assets"] }));
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

  test("when every job is still running, the oldest runner is evicted", async () => {
    const oldest = await store.createJob("c0");
    for (let i = 1; i < MAX_JOBS; i++) await store.createJob(`c${i}`);
    await store.createJob("overflow");
    expect(await store.getJob(oldest)).toBeUndefined();
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

  test("cached settled job is expired and deleted on getStoredJob when past TTL", async () => {
    const id = await store.createJob("camp");
    await store.failJob(id, "err");
    const cached = (store as unknown as { memoryCache: Map<string, { entry: StoredJob; mtimeMs: number }> }).memoryCache.get(id);
    expect(cached).toBeDefined();
    if (cached) cached.entry = { ...cached.entry, settledAt: Date.now() - (JOB_TTL_MS + 1000) };
    expect(await store.getJob(id)).toBeUndefined();
  });

  test("expireLater clears existing timer if job settles again", async () => {
    const id = await store.createJob("camp");
    await store.failJob(id, "first");
    await store.failJob(id, "second");
    expect(await store.getJob(id)).toMatchObject({ status: "failed", error: "second" });
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
    const entry1: StoredJob = { id: "b", campaignId: "c", job: { status: "running", done: 0, total: 0, log: null }, createdAt: now, seq: 1 };
    const entry2: StoredJob = { id: "a", campaignId: "c", job: { status: "running", done: 0, total: 0, log: null }, createdAt: now, seq: 1 };
    const entry3: StoredJob = { id: "c", campaignId: "c", job: { status: "running", done: 0, total: 0, log: null }, createdAt: now - 1000, seq: 1 };
    const entry4: StoredJob = { id: "d", campaignId: "c", job: { status: "running", done: 0, total: 0, log: null }, createdAt: now, seq: 2 };

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

  test.skipIf(!canDenyRead)("getStoredJob, deleteJob, listJobs, clear rethrow non-ENOENT errors", async () => {
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
  });

  test.skipIf(!canDenyRead)("getStoredJob rethrows when readFile fails with non-ENOENT error", async () => {
    const id = await store.createJob("camp");
    (store as unknown as { memoryCache: Map<string, unknown> }).memoryCache.clear();
    const filePath = store.jobPath(id);
    chmodSync(filePath, 0o000);
    try {
      await expect(store.getStoredJob(id)).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      chmodSync(filePath, 0o644);
    }
  });

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

  test.skipIf(!canDenyRead)("writeJobEntry cleans up and throws when directory write fails", async () => {
    chmodSync(dir, 0o555);
    try {
      await expect(store.createJob("camp")).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      chmodSync(dir, 0o755);
    }
  });
});
