import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isErrno } from "../brief-files.js";
import { outputRoot } from "../config.js";
import { resolveConfined } from "../confined-path.js";
import type { Job, JobResult, JobStorePort, StoredJob } from "./job-store.port.js";

/** Most jobs kept in storage; the oldest are evicted first (terminal ones before running). */
export const MAX_JOBS = 50;
/** How long a settled job stays pollable after it completes or fails. */
export const JOB_TTL_MS = 10 * 60_000;

/**
 * Every slot is a live run, so there is nothing to retire (R1).
 *
 * Distinct from “this campaign is already running”, which `acquireJob`
 * answers with the incumbent's id: this is the server being at capacity, and
 * the caller should be told rather than have a stranger's run deleted to make
 * space.
 */
export class JobCapacityError extends Error {
  constructor(running: number) {
    super(
      `All ${running} job slots are running campaigns; no settled job can be retired. Try again once one finishes.`,
    );
    this.name = "JobCapacityError";
  }
}

let globalJobSeq = 0;

interface CacheItem {
  entry: StoredJob;
  mtimeMs: number;
}

/**
 * Filesystem implementation of JobStorePort.
 * Stores jobs under `<outputRoot>/jobs/<id>.json`.
 *
 * Persisted to disk with atomic temp-and-rename so handles survive process
 * boundaries and can be resolved across server instances.
 */
export class FsJobStore implements JobStorePort {
  private readonly customDir?: string;
  private readonly lockChains = new Map<string, Promise<unknown>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly memoryCache = new Map<string, CacheItem>();

  constructor(dir?: string) {
    if (dir) this.customDir = resolve(dir);
  }

  private get dir(): string {
    return this.customDir ?? resolve(outputRoot(), "jobs");
  }

  getJobsDir(): string {
    return this.dir;
  }

  jobPath(id: string): string {
    return resolveConfined(this.dir, `${id}.json`);
  }

  private async writeJobEntry(entry: StoredJob): Promise<void> {
    const dest = this.jobPath(entry.id);
    const tmp = `${dest}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
    try {
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(tmp, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
      await rename(tmp, dest);
      const st = await stat(dest);
      this.memoryCache.set(entry.id, { entry, mtimeMs: st.mtimeMs });
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Make room by retiring SETTLED jobs only (R1, D73).
   *
   * It used to fall back to `index 0` — the oldest entry — whenever no
   * settled job existed, which is the oldest RUNNER. A live campaign was
   * therefore deleted out from under itself: its lock vanished, a second
   * Generate for the same campaign was admitted, and the two runs wrote over
   * each other.
   *
   * Why this could not be fixed on its own, and why R5 is in the same change:
   * `expireLater` is called only from `settle`, so a RUNNING job never
   * expires. Before the run deadline landed, eviction was the only thing that
   * ever reclaimed a slot from a hung run — refusing to evict runners without
   * bounding them would have let fifty hung jobs wedge the API permanently.
   * With every run now carrying a deadline, a runner always settles, so
   * refusing here is safe and a full store is a real capacity signal rather
   * than a leak.
   */
  private async evictToFit(): Promise<void> {
    const jobs = (await this.listJobs()).slice();
    while (jobs.length >= MAX_JOBS) {
      const settledIndex = jobs.findIndex((entry) => entry.job.status !== "running");
      if (settledIndex === -1) {
        throw new JobCapacityError(jobs.length);
      }
      const [evicted] = jobs.splice(settledIndex, 1);
      await this.deleteJob(evicted!.id);
    }
  }

  private expireLater(id: string): void {
    const existing = this.timers.get(id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      void this.deleteJob(id).catch(() => undefined);
    }, JOB_TTL_MS);
    timer.unref();
    this.timers.set(id, timer);
  }

  async getStoredJob(id: string): Promise<StoredJob | undefined> {
    let st;
    try {
      st = await stat(this.jobPath(id));
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        this.memoryCache.delete(id);
        return undefined;
      }
      throw error;
    }

    const cached = this.memoryCache.get(id);
    if (cached && cached.mtimeMs >= st.mtimeMs) {
      if (
        cached.entry.settledAt !== undefined &&
        Date.now() - cached.entry.settledAt >= JOB_TTL_MS
      ) {
        await this.deleteJob(id);
        return undefined;
      }
      return cached.entry;
    }

    let raw: string;
    try {
      raw = await readFile(this.jobPath(id), "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.deleteJob(id);
      return undefined;
    }

    const entry = parsed as StoredJob;
    if (entry.settledAt !== undefined && Date.now() - entry.settledAt >= JOB_TTL_MS) {
      await this.deleteJob(id);
      return undefined;
    }
    this.memoryCache.set(id, { entry, mtimeMs: st.mtimeMs });
    return entry;
  }

  async getJob(id: string): Promise<Job | undefined> {
    const entry = await this.getStoredJob(id);
    return entry?.job;
  }

  async acquireJob(
    campaignId: string,
    customId?: string,
  ): Promise<{ acquired: true; jobId: string } | { acquired: false; runningJobId: string }> {
    return this.withJobLock(campaignId, async () => {
      const runningId = await this.getRunningJobId(campaignId);
      if (runningId !== undefined) {
        return { acquired: false, runningJobId: runningId };
      }
      return this.withJobLock("__capacity__", async () => {
        await this.evictToFit();
        const id = customId ?? crypto.randomUUID();
        const entry: StoredJob = {
          id,
          campaignId,
          job: { status: "running", done: 0, total: 0, log: null },
          createdAt: Date.now(),
          seq: ++globalJobSeq,
        };
        await this.writeJobEntry(entry);
        return { acquired: true, jobId: id };
      });
    });
  }

  async createJob(campaignId: string, customId?: string): Promise<string> {
    const claim = await this.acquireJob(campaignId, customId);
    return claim.acquired ? claim.jobId : claim.runningJobId;
  }

  async getRunningJobId(campaignId: string): Promise<string | undefined> {
    const jobs = await this.listJobs();
    for (const entry of jobs) {
      if (entry.campaignId === campaignId && entry.job.status === "running") {
        return entry.id;
      }
    }
    return undefined;
  }

  async hasRunningJob(campaignId: string): Promise<boolean> {
    return (await this.getRunningJobId(campaignId)) !== undefined;
  }

  async completeJob(id: string, payload: JobResult): Promise<void> {
    return this.withJobLock(id, async () => {
      const entry = await this.getStoredJob(id);
      if (!entry) return;
      const n = payload.halted ? 0 : payload.assets.length;
      const updated: StoredJob = {
        ...entry,
        job: {
          status: "completed",
          done: n,
          total: n,
          log: payload.log,
          result: payload,
        },
        settledAt: Date.now(),
      };
      await this.writeJobEntry(updated);
      this.expireLater(id);
    });
  }

  async failJob(id: string, error: string): Promise<void> {
    return this.withJobLock(id, async () => {
      const entry = await this.getStoredJob(id);
      if (!entry) return;
      const updated: StoredJob = {
        ...entry,
        job: {
          status: "failed",
          done: 0,
          total: 0,
          log: null,
          error,
        },
        settledAt: Date.now(),
      };
      await this.writeJobEntry(updated);
      this.expireLater(id);
    });
  }

  async deleteJob(id: string): Promise<void> {
    this.memoryCache.delete(id);
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    try {
      await unlink(this.jobPath(id));
    } catch (error) {
      if (isErrno(error, "ENOENT")) return;
      throw error;
    }
  }

  async listJobs(): Promise<readonly StoredJob[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return [];
      throw error;
    }

    const jsonFiles = files.filter((f) => f.endsWith(".json"));
    const entries: StoredJob[] = [];
    for (const file of jsonFiles) {
      const id = file.slice(0, -5);
      const stored = await this.getStoredJob(id);
      if (stored) entries.push(stored);
    }
    return entries.sort(
      (a, b) => a.createdAt - b.createdAt || a.seq - b.seq || a.id.localeCompare(b.id),
    );
  }

  async clear(): Promise<void> {
    this.memoryCache.clear();
    for (const [, timer] of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    try {
      const files = await readdir(this.dir);
      for (const file of files) {
        if (file.endsWith(".json") || file.endsWith(".tmp")) {
          await unlink(resolve(this.dir, file)).catch(() => undefined);
        }
      }
    } catch (error) {
      if (isErrno(error, "ENOENT")) return;
      throw error;
    }
  }

  withJobLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.lockChains.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.lockChains.set(key, settled);
    void settled.then(() => {
      if (this.lockChains.get(key) === settled) this.lockChains.delete(key);
    });
    return run;
  }
}

export const FsJobRegistry = FsJobStore;
export type FsJobRegistry = FsJobStore;
