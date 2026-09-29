import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isErrno } from "../brief-files.js";
import { resolveConfined } from "../confined-path.js";
import {
  JobLeaseLostError,
  QUEUED_TTL_MS,
  type Job,
  type JobResult,
  type JobStorePort,
  type StoredJob,
} from "./job-store.port.js";

/** Most jobs kept in storage; the oldest are evicted first (terminal ones before running). */
export const MAX_JOBS = 50;
/** How long a settled job stays pollable after it completes or fails. */
export const JOB_TTL_MS = 10 * 60_000;
/**
 * Grace period after the run deadline before a running job is considered stale.
 * The in-process deadline (RUN_DEADLINE_MS, which equals JOB_TTL_MS) settles the
 * run at JOB_TTL_MS; this grace keeps a legitimately finishing run from being
 * reaped if the process dies just as the run is completing its final writes.
 */
export const STALE_GRACE_MS = 60_000;

/** Message written when a stale running job is reaped after a process crash. */
export const STALE_RUNNING_MESSAGE = "Run interrupted: the server stopped before it finished.";

const QUEUED_EXPIRED_MESSAGE = "Queued run expired before a worker started it.";

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
  /** Resolved once at construction; the composition root decides it (D167). */
  private readonly dir: string;
  private readonly lockChains = new Map<string, Promise<unknown>>();
  /**
   * Which lock keys the CURRENT async call chain already holds, so
   * `withJobLock` can tell "this is a nested call from code that is already
   * inside this key's critical section" (run inline — the queue below is
   * strictly FIFO per key, so queuing behind ourselves would wait forever)
   * apart from "this is a separate, genuinely concurrent caller" (queue
   * normally). Nesting happens both inside this file (e.g. `getStoredJob`
   * reaping under the id lock while called from `progressJob`, which already
   * holds it) and from callers outside it that fence a read inside their own
   * `withJobLock` section (`report.ts`, `decisions.ts` via `retireDecisions`).
   */
  private readonly lockContext = new AsyncLocalStorage<ReadonlySet<string>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly queuedTimers = new Map<string, NodeJS.Timeout>();
  private readonly memoryCache = new Map<string, CacheItem>();

  constructor(dir: string) {
    this.dir = resolve(dir);
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
      const settledIndex = jobs.findIndex(
        (entry) => entry.job.status !== "running" && entry.job.status !== "queued",
      );
      if (settledIndex === -1) {
        throw new JobCapacityError(jobs.length);
      }
      const [evicted] = jobs.splice(settledIndex, 1);
      await this.deleteJob(evicted!.id);
    }
  }

  private expireLater(id: string): void {
    // A custom id can be reused once its job has settled (`acquireJob`), so the
    // earlier entry's timer must not outlive it and delete the replacement.
    const existing = this.timers.get(id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      void this.deleteJob(id).catch(() => undefined);
    }, JOB_TTL_MS);
    timer.unref();
    this.timers.set(id, timer);
  }

  /**
   * Cancel a pending settle-retention timer for `id`, if one exists.
   *
   * `expireLater` only clears an EARLIER retention timer when a job settles
   * again under the same id — it is never called at acquire time. So an id
   * settled once (including by the stale-running reaper) and then reused by
   * `acquireJob`/`enqueueJob` before its retention timer fires carries that
   * timer forward: at JOB_TTL_MS past the FIRST settlement, `deleteJob(id)`
   * fires regardless of what now lives at that id, unlinking the reused
   * entry's file out from under a run that may still be going. Call this
   * before writing a fresh entry for a (possibly reused) id.
   */
  private cancelPendingRetention(id: string): void {
    const existing = this.timers.get(id);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(id);
    }
  }

  private expireQueuedLater(id: string): void {
    const existing = this.queuedTimers.get(id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      // `getStoredJob`'s own on-read staleness check (below) performs exactly
      // this "still queued past its TTL → failed" write as a side effect — it
      // must, so a caller polling this id sees it as failed even before this
      // timer fires. By the time this callback runs, elapsed time is always
      // >= QUEUED_TTL_MS, so that check is always true here; a second,
      // duplicate write from this callback could never run (getStoredJob
      // would already have changed the status to something other than
      // "queued"), so this exists only to settle a row nobody ever polls —
      // the same reason `expireLater`'s own callback exists for a settled row.
      void this.withJobLock(id, () => this.getStoredJob(id)).catch(() => undefined);
    }, QUEUED_TTL_MS);
    timer.unref();
    this.queuedTimers.set(id, timer);
  }

  /**
   * Cheap, read-only check: is this a running job whose startedAt (or
   * createdAt as fallback, for rows written before that field existed) is
   * older than the run deadline plus the grace period? A plain time
   * comparison against whatever entry the caller has in hand (cached or
   * freshly read) — no lock, no disk I/O — so the common case (a running
   * job well inside its deadline, polled repeatedly while it works) never
   * pays for either.
   */
  private isStaleRunning(entry: StoredJob): boolean {
    if (entry.job.status !== "running") return false;
    const startTime = entry.startedAt ?? entry.createdAt;
    return Date.now() - startTime >= JOB_TTL_MS + STALE_GRACE_MS;
  }

  /**
   * Rewrite a running entry as failed with the stale running message, set
   * settledAt to now, and schedule expireLater. Callers must have already
   * confirmed `isStaleRunning(entry)` on a freshly read copy — see
   * `reapStaleRunningLocked`, the only caller.
   */
  private async reapStaleRunning(entry: StoredJob): Promise<StoredJob> {
    const updated: StoredJob = {
      ...entry,
      job: {
        status: "failed",
        done: 0,
        total: 0,
        log: null,
        error: STALE_RUNNING_MESSAGE,
      },
      settledAt: Date.now(),
    };
    await this.writeJobEntry(updated);
    this.expireLater(entry.id);
    return updated;
  }

  /**
   * Called once `isStaleRunning` says a cached or just-read entry looks past
   * its deadline. Takes the id's lock and RE-READS the file fresh before
   * deciding anything: between that earlier look and this call actually
   * running, another id-locked write on this instance (completeJob, failJob,
   * a heartbeat) — or the very call chain that is already holding this id's
   * lock when it reads through here — could have settled the job. Reaps only
   * if the freshest copy on disk is STILL running and STILL stale; otherwise
   * returns that freshest copy untouched, so a job someone else finished in
   * the meantime is never overwritten as crashed.
   *
   * `withJobLock` is reentrant for a lock the current call chain already
   * holds (see its doc), so this is safe to call whether or not the caller
   * already holds `id`'s lock.
   */
  private async reapStaleRunningLocked(id: string): Promise<StoredJob | undefined> {
    return this.withJobLock(id, async () => {
      const fresh = await this.readEntryFromDisk(id);
      if (fresh === undefined) return undefined;
      if (!this.isStaleRunning(fresh)) {
        const freshStat = await stat(this.jobPath(id)).catch(() => undefined);
        if (freshStat) this.memoryCache.set(id, { entry: fresh, mtimeMs: freshStat.mtimeMs });
        return fresh;
      }
      return this.reapStaleRunning(fresh);
    });
  }

  /**
   * Raw disk read for `id`: undefined if the file is gone (cache is cleared
   * to match) or unparsable (the corrupt file is deleted, same handling as
   * the cold-read path in `getStoredJob`).
   */
  private async readEntryFromDisk(id: string): Promise<StoredJob | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.jobPath(id), "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        this.memoryCache.delete(id);
        return undefined;
      }
      throw error;
    }
    try {
      return JSON.parse(raw) as StoredJob;
    } catch {
      await this.deleteJob(id);
      return undefined;
    }
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
      if (
        cached.entry.job.status === "queued" &&
        Date.now() - cached.entry.createdAt >= QUEUED_TTL_MS
      ) {
        const updated: StoredJob = {
          ...cached.entry,
          job: {
            status: "failed",
            done: 0,
            total: 0,
            log: null,
            error: QUEUED_EXPIRED_MESSAGE,
          },
          settledAt: Date.now(),
        };
        await this.writeJobEntry(updated);
        this.expireLater(id);
        return updated;
      }
      // Check for stale running job (cached). A cheap time comparison first
      // — only when it looks stale do we pay for the lock and a fresh
      // re-read (reapStaleRunningLocked), so a running job well inside its
      // deadline never touches either on a normal poll.
      if (this.isStaleRunning(cached.entry)) {
        return this.reapStaleRunningLocked(id);
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
    if (entry.job.status === "queued" && Date.now() - entry.createdAt >= QUEUED_TTL_MS) {
      const updated: StoredJob = {
        ...entry,
        job: {
          status: "failed",
          done: 0,
          total: 0,
          log: null,
          error: QUEUED_EXPIRED_MESSAGE,
        },
        settledAt: Date.now(),
      };
      await this.writeJobEntry(updated);
      this.expireLater(id);
      return updated;
    }
    // Check for stale running job (disk read). Same cheap-check-first shape
    // as the cached branch above; reapStaleRunningLocked re-reads the file
    // again under the lock rather than trusting this `entry`, in case a
    // concurrent id-locked write landed between this read and the lock.
    if (this.isStaleRunning(entry)) {
      return this.reapStaleRunningLocked(id);
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
        this.cancelPendingRetention(id);
        const now = Date.now();
        const entry: StoredJob = {
          id,
          campaignId,
          job: { status: "running", done: 0, total: 0, log: null },
          createdAt: now,
          startedAt: now,
          seq: ++globalJobSeq,
        };
        await this.writeJobEntry(entry);
        return { acquired: true, jobId: id };
      });
    });
  }

  async enqueueJob(
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
        this.cancelPendingRetention(id);
        const entry: StoredJob = {
          id,
          campaignId,
          job: { status: "queued", done: 0, total: 0, log: null },
          createdAt: Date.now(),
          seq: ++globalJobSeq,
        };
        await this.writeJobEntry(entry);
        this.expireQueuedLater(id);
        return { acquired: true, jobId: id };
      });
    });
  }

  async startQueuedJob(id: string): Promise<boolean> {
    return this.withJobLock(id, async () => {
      const entry = await this.getStoredJob(id);
      if (!entry || entry.job.status !== "queued") return false;
      const timer = this.queuedTimers.get(id);
      if (timer) {
        clearTimeout(timer);
        this.queuedTimers.delete(id);
      }
      const updated: StoredJob = {
        ...entry,
        job: {
          ...entry.job,
          status: "running",
        },
        startedAt: Date.now(),
      };
      await this.writeJobEntry(updated);
      return true;
    });
  }

  async createJob(campaignId: string, customId?: string): Promise<string> {
    const claim = await this.acquireJob(campaignId, customId);
    return claim.acquired ? claim.jobId : claim.runningJobId;
  }

  async getRunningJobId(campaignId: string): Promise<string | undefined> {
    const jobs = await this.listJobs();
    for (const entry of jobs) {
      if (
        entry.campaignId === campaignId &&
        (entry.job.status === "running" || entry.job.status === "queued")
      ) {
        return entry.id;
      }
    }
    return undefined;
  }

  async hasRunningJob(campaignId: string): Promise<boolean> {
    return (await this.getRunningJobId(campaignId)) !== undefined;
  }

  async progressJob(id: string, done: number, total: number): Promise<void> {
    return this.withJobLock(id, async () => {
      const entry = await this.getStoredJob(id);
      if (!entry) return;
      // Only a running job takes progress. `runJob`'s deadline can fail a job
      // while the work it could not kill carries on ticking, and that work
      // finishes into a settled entry — writing here would flip "failed" back
      // to "running" and hand the poller a run that is never coming back.
      if (entry.job.status !== "running") return;
      await this.writeJobEntry({ ...entry, job: { ...entry.job, done, total } });
    });
  }

  async completeJob(id: string, payload: JobResult): Promise<void> {
    return this.withJobLock(id, async () => {
      const entry = await this.getStoredJob(id);
      if (!entry) return;
      if (entry.job.status !== "running") throw new JobLeaseLostError(id);
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
      if (entry.job.status !== "running") throw new JobLeaseLostError(id);
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
    const qTimer = this.queuedTimers.get(id);
    if (qTimer) {
      clearTimeout(qTimer);
      this.queuedTimers.delete(id);
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
    for (const [, timer] of this.queuedTimers) {
      clearTimeout(timer);
    }
    this.queuedTimers.clear();
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
    const held = this.lockContext.getStore();
    if (held?.has(key)) {
      // Reentrant: the caller is already running inside this key's critical
      // section (see the `lockContext` field doc). Run inline — we are
      // already serialized against every other user of this key.
      return fn();
    }
    const nextContext = new Set(held ?? []);
    nextContext.add(key);
    const runInContext = () => this.lockContext.run(nextContext, fn);
    const previous = this.lockChains.get(key) ?? Promise.resolve();
    const run = previous.then(runInContext, runInContext);
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
