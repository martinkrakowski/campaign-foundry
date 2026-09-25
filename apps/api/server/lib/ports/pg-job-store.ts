import { randomUUID } from "node:crypto";
import type { SqlClient, SqlQuery } from "../db/sql-client.js";
import { JOB_TTL_MS, JobCapacityError, MAX_JOBS } from "./fs-job-store.js";
import type {
  Job,
  JobResult,
  JobStatus,
  RunRegistryPort,
  StoredJob,
} from "./job-store.port.js";

/**
 * How long a claim's lease lasts without a heartbeat (D171). Well above
 * `HEARTBEAT_INTERVAL_MS` so a few missed beats (a slow tick, a GC pause) never
 * cost a live worker its campaign; well below `JOB_TTL_MS` so a crashed worker's
 * campaign is claimable again long before its job row would expire anyway.
 */
export const LEASE_MS = 60_000;

/** How often `runJob` (`lib/jobs.ts`) refreshes a claim's lease while it runs. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Thrown by a fenced write (`progressJob`, `completeJob`, `failJob`) when the
 * job row no longer holds the lease it was minted with: the reaper already
 * failed it, or it was already settled. The write is refused rather than
 * silently dropped, because unlike a progress tick (advisory, and already
 * swallowed by its only caller) a completion or failure is the one thing that
 * must never land on a campaign another worker has since claimed.
 */
export class JobLeaseLostError extends Error {
  constructor(id: string) {
    super(`Job "${id}" no longer holds its lease (it was reaped or already settled).`);
    this.name = "JobLeaseLostError";
  }
}

/** A millisecond duration as the text `pg`/PGlite parse into an `interval`. */
function asInterval(ms: number): string {
  return `${ms} milliseconds`;
}

interface JobRow {
  id: string;
  campaign_id: string;
  status: JobStatus;
  done: number;
  total: number;
  log: Job["log"];
  result: JobResult | null;
  error: string | null;
  created_at: Date;
  settled_at: Date | null;
  seq: number | string;
}

function toJob(row: JobRow): Job {
  return {
    status: row.status,
    done: row.done,
    total: row.total,
    log: row.log,
    ...(row.result !== null ? { result: row.result } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
  };
}

function toStoredJob(row: JobRow): StoredJob {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    job: toJob(row),
    createdAt: row.created_at.getTime(),
    // bigserial: `pg` returns it as a string (int8 is outside the safe-integer
    // guarantee it will make for any column), PGlite as a number. Either way it
    // is small enough here that `Number` loses nothing.
    seq: Number(row.seq),
    ...(row.settled_at !== null ? { settledAt: row.settled_at.getTime() } : {}),
  };
}

/**
 * The columns every read needs, and the TTL filter every read applies (item 6):
 * a settled row past `JOB_TTL_MS` reads as gone, the same as a file store's
 * passive expiry, without a background sweep.
 */
const SELECT_COLUMNS = `id, campaign_id, status, done, total, log, result, error, created_at, settled_at, seq`;

/**
 * Jobs as rows (PT-6a, D171), one org's: the run's lease, adoption handle and
 * poll target. Every statement is scoped to the org, so another org's jobs are
 * invisible and its own capacity (`MAX_JOBS`) is its own.
 */
export class PgJobStore implements RunRegistryPort {
  constructor(
    private readonly db: SqlClient,
    private readonly orgId: string,
  ) {}

  /**
   * Fail every running row of this org whose lease has lapsed — a separate
   * statement, run before the claim (item 4), so a claim never has to reason
   * about a stale lease itself: by the time it runs, a lapsed row has already
   * left `where status = 'running'`, the claim's conflict target.
   */
  private async reap(tx: SqlQuery): Promise<void> {
    await tx.query(
      `update job set status = 'failed',
              error = 'Lease expired: the worker holding it stopped heartbeating.',
              settled_at = now()
       where org_id = $1 and status = 'running' and lease_expires_at < now()`,
      [this.orgId],
    );
  }

  /**
   * `fs-job-store.ts`'s `evictToFit`, in SQL: settled jobs past `JOB_TTL_MS` are
   * purged outright (they already read as gone, item 6), then the oldest
   * settled row is retired while the org is at `MAX_JOBS`. When every row is
   * running, refuse rather than evict one out from under a live worker — the
   * same capacity signal the file store gives (`JobCapacityError`).
   */
  private async evictToFit(tx: SqlQuery): Promise<void> {
    await tx.query(
      `delete from job where org_id = $1 and settled_at is not null
         and settled_at <= now() - $2::interval`,
      [this.orgId, asInterval(JOB_TTL_MS)],
    );
    for (;;) {
      const { rows: counted } = await tx.query<{ n: number }>(
        `select count(*)::int as n from job where org_id = $1`,
        [this.orgId],
      );
      const n = counted[0]!.n;
      if (n < MAX_JOBS) return;
      const evicted = await tx.query<{ id: string }>(
        `delete from job where id = (
           select id from job where org_id = $1 and status != 'running'
           order by created_at asc, seq asc limit 1
         )
         returning id`,
        [this.orgId],
      );
      if (evicted.rows.length === 0) throw new JobCapacityError(n);
    }
  }

  async acquireJob(
    campaignId: string,
    customId?: string,
  ): Promise<{ acquired: true; jobId: string } | { acquired: false; runningJobId: string }> {
    return this.db.transaction(async (tx) => {
      await this.reap(tx);
      await this.evictToFit(tx);
      const id = customId ?? randomUUID();
      // The one statement (item 2): an insert whose conflict target is the
      // partial unique index, so a row that is not currently running never
      // blocks it. `do update` (a no-op write of the value already there) only
      // exists so `returning` always answers — `do nothing` answers nothing on
      // the conflict path. `xmax = 0` is true only for a row this statement
      // itself inserted: the classic way to tell "I inserted" from "I found the
      // incumbent" out of one `returning`.
      const { rows } = await tx.query<{ id: string; acquired: boolean }>(
        `insert into job (id, org_id, campaign_id, status, lease_expires_at, heartbeat_at)
         values ($1, $2, $3, 'running', now() + $4::interval, now())
         on conflict (org_id, campaign_id) where status = 'running'
         do update set campaign_id = excluded.campaign_id
         returning id, (xmax = 0) as acquired`,
        [id, this.orgId, campaignId, asInterval(LEASE_MS)],
      );
      const row = rows[0]!;
      return row.acquired
        ? { acquired: true, jobId: row.id }
        : { acquired: false, runningJobId: row.id };
    });
  }

  async createJob(campaignId: string, customId?: string): Promise<string> {
    const claim = await this.acquireJob(campaignId, customId);
    return claim.acquired ? claim.jobId : claim.runningJobId;
  }

  async getRunningJobId(campaignId: string): Promise<string | undefined> {
    const { rows } = await this.db.query<{ id: string }>(
      `select id from job where org_id = $1 and campaign_id = $2 and status = 'running' limit 1`,
      [this.orgId, campaignId],
    );
    return rows[0]?.id;
  }

  async hasRunningJob(campaignId: string): Promise<boolean> {
    return (await this.getRunningJobId(campaignId)) !== undefined;
  }

  async getStoredJob(id: string): Promise<StoredJob | undefined> {
    const { rows } = await this.db.query<JobRow>(
      `select ${SELECT_COLUMNS} from job
       where id = $1 and org_id = $2
         and (settled_at is null or settled_at > now() - $3::interval)`,
      [id, this.orgId, asInterval(JOB_TTL_MS)],
    );
    const row = rows[0];
    return row ? toStoredJob(row) : undefined;
  }

  async getJob(id: string): Promise<Job | undefined> {
    return (await this.getStoredJob(id))?.job;
  }

  /**
   * Extend the claim's lease. Silent when the row no longer holds one (already
   * settled, or reaped): a heartbeat is upkeep, not a claim, and there is
   * nothing here for a caller to act on — the next fenced write is where a lost
   * lease actually surfaces.
   */
  async heartbeat(id: string): Promise<void> {
    await this.db.query(
      `update job set heartbeat_at = now(), lease_expires_at = now() + $3::interval
       where id = $1 and org_id = $2 and status = 'running'`,
      [id, this.orgId, asInterval(LEASE_MS)],
    );
  }

  /** A fenced write (item 5): refused once the row is no longer this claim's to write. */
  private async fencedUpdate(id: string, sql: string, params: readonly unknown[]): Promise<void> {
    const { rows } = await this.db.query<{ id: string }>(sql, params);
    if (rows.length === 0) throw new JobLeaseLostError(id);
  }

  async progressJob(id: string, done: number, total: number): Promise<void> {
    await this.fencedUpdate(
      id,
      `update job set done = $3, total = $4
       where id = $1 and org_id = $2 and status = 'running'
       returning id`,
      [id, this.orgId, done, total],
    );
  }

  async completeJob(id: string, payload: JobResult): Promise<void> {
    const n = payload.halted ? 0 : payload.assets.length;
    await this.fencedUpdate(
      id,
      `update job set status = 'completed', done = $3, total = $3, log = $4, result = $5, settled_at = now()
       where id = $1 and org_id = $2 and status = 'running'
       returning id`,
      [id, this.orgId, n, payload.log, payload],
    );
  }

  async failJob(id: string, error: string): Promise<void> {
    await this.fencedUpdate(
      id,
      `update job set status = 'failed', done = 0, total = 0, log = null, error = $3, settled_at = now()
       where id = $1 and org_id = $2 and status = 'running'
       returning id`,
      [id, this.orgId, error],
    );
  }

  async deleteJob(id: string): Promise<void> {
    await this.db.query(`delete from job where id = $1 and org_id = $2`, [id, this.orgId]);
  }

  async listJobs(): Promise<readonly StoredJob[]> {
    const { rows } = await this.db.query<JobRow>(
      `select ${SELECT_COLUMNS} from job
       where org_id = $1
         and (settled_at is null or settled_at > now() - $2::interval)
       order by created_at asc, seq asc`,
      [this.orgId, asInterval(JOB_TTL_MS)],
    );
    return rows.map(toStoredJob);
  }

  /** Test seam: forget every job this org's store holds. */
  async clear(): Promise<void> {
    await this.db.query(`delete from job where org_id = $1`, [this.orgId]);
  }

  /**
   * The row is the lock (D171): correctness comes from the fenced statements
   * above, not an in-process chain, so there is nothing to serialize here.
   * Kept only because `JobStorePort` declares it; nothing calls it for this
   * adapter (`fs-job-store.ts` is the only caller of its own `withJobLock`).
   */
  withJobLock<T>(_key: string, fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}
