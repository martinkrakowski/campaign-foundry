import { randomUUID } from "node:crypto";
import type { SqlClient, SqlQuery } from "../db/sql-client.js";
import { JOB_TTL_MS, JobCapacityError, MAX_JOBS } from "./fs-job-store.js";
import {
  JobLeaseLostError,
  type Job,
  type JobResult,
  type JobStatus,
  type RunRegistryPort,
  type StoredJob,
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

export { JobLeaseLostError } from "./job-store.port.js";

/** A millisecond duration as the text `pg`/PGlite parse into an `interval`. */
function asInterval(ms: number): string {
  return `${ms} milliseconds`;
}

/**
 * What a lapsed lease reads as, whether the reaper already wrote it (a row
 * this org has since reaped) or a read is inferring it from `lease_expires_at`
 * before any claim has run the reaper (item 5). One string, so the two never
 * drift: `reap` passes it as a parameter rather than a second literal.
 */
const LEASE_EXPIRED_MESSAGE = "Lease expired: the worker holding it stopped heartbeating.";

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
  lease_expires_at: Date | null;
}

/**
 * A running row whose lease has lapsed reads as failed (item 5): without this,
 * a dead worker's job would still poll "running" until some unrelated claim
 * for this org happens to run the reaper. Read-only — the row itself becomes
 * `'failed'` for real the next time this org's reaper runs, with the same
 * message, so a poller never sees two different explanations for the same row.
 */
function lapsedAsFailed(row: JobRow, now: Date): JobRow {
  if (row.status !== "running" || row.lease_expires_at === null || row.lease_expires_at > now) {
    return row;
  }
  return { ...row, status: "failed", error: LEASE_EXPIRED_MESSAGE };
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
const SELECT_COLUMNS = `id, campaign_id, status, done, total, log, result, error, created_at, settled_at, seq, lease_expires_at`;

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
      `update job set status = 'failed', error = $2, settled_at = now()
       where org_id = $1 and status = 'running' and lease_expires_at < now()`,
      [this.orgId, LEASE_EXPIRED_MESSAGE],
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

  /**
   * A per-org transaction-scoped advisory lock (item 3): serializes every
   * `acquireJob` for this org across processes, so `reap` → the incumbent
   * check → capacity eviction → the claim run as one critical section. Without
   * it two concurrent claims for DIFFERENT campaigns could both count the same
   * headroom (both see `n < MAX_JOBS` and both admit, overshooting it) or both
   * evict the same oldest settled row (one finds nothing left and refuses a
   * claim capacity had room for). `hashtext` turns the org id into the lock's
   * bigint key; released automatically at commit or rollback, so a claim that
   * throws never leaves it held.
   */
  private async lockOrg(tx: SqlQuery): Promise<void> {
    await tx.query("select pg_advisory_xact_lock(hashtext('job:' || $1))", [this.orgId]);
  }

  /** The running row for `campaignId`, if any — the claim's incumbent, and `getRunningJobId`. */
  private async runningIncumbent(q: SqlQuery, campaignId: string): Promise<string | undefined> {
    const { rows } = await q.query<{ id: string }>(
      `select id from job where org_id = $1 and campaign_id = $2 and status = 'running' and lease_expires_at > now() limit 1`,
      [this.orgId, campaignId],
    );
    return rows[0]?.id;
  }

  async acquireJob(
    campaignId: string,
    customId?: string,
  ): Promise<{ acquired: true; jobId: string } | { acquired: false; runningJobId: string }> {
    return this.db.transaction(async (tx) => {
      await this.lockOrg(tx);
      await this.reap(tx);
      // The incumbent, before any capacity decision (item 1): a retry for a
      // campaign this org is already running must adopt it even when the org
      // is at `MAX_JOBS` — evicting to make room for a row that would just
      // conflict with the one already there, then throwing `JobCapacityError`
      // instead of returning the incumbent, is the file store's actual
      // behaviour and this must match it.
      const incumbent = await this.runningIncumbent(tx, campaignId);
      if (incumbent !== undefined) return { acquired: false, runningJobId: incumbent };
      await this.evictToFit(tx);
      const id = customId ?? randomUUID();
      // The one statement (item 2): an insert whose conflict target is the
      // partial unique index, so a row that is not currently running never
      // blocks it. `do update` (a no-op write of the value already there) only
      // exists so `returning` always answers — `do nothing` answers nothing on
      // the conflict path. `xmax = 0` is true only for a row this statement
      // itself inserted: the classic way to tell "I inserted" from "I found the
      // incumbent" out of one `returning`. With the org lock held, no other
      // transaction for this org can be here at the same time, so the conflict
      // path is now a belt-and-braces check, not the only thing preventing a
      // double-admit — but it is also what a two-connection race without the
      // lock (an older client, a future bypass) still falls back on safely.
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
    return this.runningIncumbent(this.db, campaignId);
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
    return row ? toStoredJob(lapsedAsFailed(row, new Date())) : undefined;
  }

  async getJob(id: string): Promise<Job | undefined> {
    return (await this.getStoredJob(id))?.job;
  }

  /**
   * Extend the claim's lease. Silent when the row no longer holds one (already
   * settled, reaped, or the lease itself already lapsed — item 2: a heartbeat
   * that arrives late must not renew a lease that has already run out, even
   * before some other claim's reaper gets around to writing `'failed'`). A
   * heartbeat is upkeep, not a claim, and there is nothing here for a caller
   * to act on — the next fenced write is where a lost lease actually surfaces.
   */
  async heartbeat(id: string): Promise<void> {
    await this.db.query(
      `update job set heartbeat_at = now(), lease_expires_at = now() + $3::interval
       where id = $1 and org_id = $2 and status = 'running' and lease_expires_at > now()`,
      [id, this.orgId, asInterval(LEASE_MS)],
    );
  }

  /**
   * A fenced write (item 5, extended by item 2): refused once the row is no
   * longer this claim's to write — settled, reaped, or its lease has simply
   * lapsed. `status = 'running'` alone is not enough: a delayed worker's write
   * can arrive after its own lease expired but before anyone's reaper has
   * caught up (the reaper only runs inside another claim), so the write must
   * check the lease itself rather than trust a status nobody has updated yet.
   */
  private async fencedUpdate(id: string, sql: string, params: readonly unknown[]): Promise<void> {
    const { rows } = await this.db.query<{ id: string }>(sql, params);
    if (rows.length === 0) throw new JobLeaseLostError(id);
  }

  async progressJob(id: string, done: number, total: number): Promise<void> {
    await this.fencedUpdate(
      id,
      `update job set done = $3, total = $4
       where id = $1 and org_id = $2 and status = 'running' and lease_expires_at > now()
       returning id`,
      [id, this.orgId, done, total],
    );
  }

  async completeJob(id: string, payload: JobResult): Promise<void> {
    const n = payload.halted ? 0 : payload.assets.length;
    await this.fencedUpdate(
      id,
      `update job set status = 'completed', done = $3, total = $3, log = $4, result = $5, settled_at = now()
       where id = $1 and org_id = $2 and status = 'running' and lease_expires_at > now()
       returning id`,
      [id, this.orgId, n, payload.log, payload],
    );
  }

  async failJob(id: string, error: string): Promise<void> {
    await this.fencedUpdate(
      id,
      `update job set status = 'failed', done = 0, total = 0, log = null, error = $3, settled_at = now()
       where id = $1 and org_id = $2 and status = 'running' and lease_expires_at > now()
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
    const now = new Date();
    return rows.map((row) => toStoredJob(lapsedAsFailed(row, now)));
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
