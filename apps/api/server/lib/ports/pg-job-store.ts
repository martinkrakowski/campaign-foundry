import { randomUUID } from "node:crypto";
import type { SqlClient, SqlQuery } from "../db/sql-client.js";
import { UUID_PATTERN } from "../object-store/object-keys.js";
import { JOB_TTL_MS, JobCapacityError, MAX_JOBS } from "./fs-job-store.js";
import {
  CampaignGoneError,
  JobLeaseLostError,
  QUEUED_TTL_MS,
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
const QUEUED_EXPIRED_MESSAGE = "Queued run expired before a worker started it.";

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
  if (row.status === "running" && (row.lease_expires_at === null || row.lease_expires_at <= now)) {
    return { ...row, status: "failed", error: LEASE_EXPIRED_MESSAGE };
  }
  if (row.status === "queued" && now.getTime() - row.created_at.getTime() >= QUEUED_TTL_MS) {
    return { ...row, status: "failed", error: QUEUED_EXPIRED_MESSAGE };
  }
  return row;
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
 *
 * Lock order (D235). This file now holds THREE claim-or-refuse paths that each
 * touch the campaign row; a future lane adding a fourth MUST check against all
 * three, not assume there are only two:
 *
 *  (i) `acquireJob`/`enqueueJob`: the org advisory lock (`lockOrg`) THEN the
 *      campaign row `for share`. (It reads/inserts `job` rows only AFTER the
 *      campaign row.)
 *  (ii) `startQueuedJob`: the `job` row `for update` (by its own primary key)
 *       THEN the campaign row `for share` — no org lock at all. It takes its
 *       job row BEFORE the campaign row, the opposite order from (i), which is
 *       benign only because (i) and (ii) both hold the campaign row `for share`
 *       and a share on a row already shared waits for nothing.
 *  (iii) the delete/tombstone transaction (PT-9f, unmerged): the campaign row
 *       ONLY, `for update`, no org lock and no job-row lock of its own (it reads
 *       `job` unlocked).
 *
 * No two of the three take the same two resources in opposite orders, so there
 * is no cycle — whichever transaction commits first decides. (i) takes job rows
 * AFTER the campaign row and (ii) takes its job row BEFORE it: opposite orders,
 * benign only because both hold the campaign row `for share` and share/share
 * never waits. A future lane that upgrades either side to `for update` closes
 * exactly that cycle; that is the line this summary exists to make visible.
 */
export class PgJobStore implements RunRegistryPort {
  constructor(
    private readonly db: SqlClient,
    private readonly orgId: string,
  ) {}

  /**
   * Fail every running row of this org whose lease has lapsed, and every queued
   * row older than QUEUED_TTL_MS (item 2).
   */
  private async reap(tx: SqlQuery): Promise<void> {
    await tx.query(
      `update job set status = 'failed', error = $2, settled_at = now()
       where org_id = $1 and status = 'running' and lease_expires_at < now()`,
      [this.orgId, LEASE_EXPIRED_MESSAGE],
    );
    await tx.query(
      `update job set status = 'failed', error = $2, settled_at = now()
       where org_id = $1 and status = 'queued' and created_at <= now() - $3::interval`,
      [this.orgId, QUEUED_EXPIRED_MESSAGE, asInterval(QUEUED_TTL_MS)],
    );
  }

  /**
   * `fs-job-store.ts`'s `evictToFit`, in SQL: settled jobs past `JOB_TTL_MS` are
   * purged outright (they already read as gone, item 6), then the oldest
   * settled row is retired while the org is at `MAX_JOBS`. When every row is
   * active (queued or running), refuse rather than evict one out from under a
   * live worker — the same capacity signal the file store gives (`JobCapacityError`).
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
           select id from job where org_id = $1 and status not in ('queued', 'running')
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

  /** The active row for `campaignId`, if any — the claim's incumbent, and `getRunningJobId`. */
  private async runningIncumbent(q: SqlQuery, campaignId: string): Promise<string | undefined> {
    const { rows } = await q.query<{ id: string }>(
      `select id from job where org_id = $1 and campaign_id = $2
         and (
           (status = 'running' and lease_expires_at > now())
           or (status = 'queued' and created_at > now() - $3::interval)
         )
       limit 1`,
      [this.orgId, campaignId, asInterval(QUEUED_TTL_MS)],
    );
    return rows[0]?.id;
  }

  /**
   * PT-9c (D235): the campaign a claim is for must still be live — present and
   * un-tombstoned — before a run is claimed against it. Mirrors
   * `PgBriefStore.resolveCampaign`'s uuid-then-slug shape (D246): a canonical
   * uuid is tried as an `id` first (gated on the shared `UUID_PATTERN`, so a
   * slug-shaped ref never reaches `::uuid` and raises `22P02`), then falls
   * through unconditionally to the slug branch — because id and slug share one
   * text space, a uuid-shaped ref that is no live id may still be a live
   * campaign's slug. One statement cannot serve both shapes (Postgres types a
   * unioned `$2` from the first cast and rejects the other branch's operator),
   * so this is two parameterised queries, exactly `resolveCampaign`'s control
   * flow. Returns a boolean and never throws — each call site decides what a
   * `false` means. Both branches take the row `for share` so a concurrent
   * tombstone (`for update`, PT-9f) serialises with the claim rather than the
   * claim racing past a just-committed delete.
   */
  private async campaignClaimable(tx: SqlQuery, campaignId: string): Promise<boolean> {
    if (UUID_PATTERN.test(campaignId)) {
      const { rows } = await tx.query(
        `select 1 from campaign where org_id = $1 and id = $2::uuid and deleted_at is null for share`,
        [this.orgId, campaignId.toLowerCase()],
      );
      if (rows.length > 0) return true;
      // Falls through: id and slug share one text space (campaignMeta's shape)
      // — a uuid-shaped ref that is no live id may still be a live campaign's slug.
    }
    const { rows } = await tx.query(
      `select 1 from campaign where org_id = $1 and slug = $2 and deleted_at is null for share`,
      [this.orgId, campaignId],
    );
    return rows.length > 0;
  }

  async acquireJob(
    campaignId: string,
    customId?: string,
  ): Promise<{ acquired: true; jobId: string } | { acquired: false; runningJobId: string }> {
    return this.db.transaction(async (tx) => {
      await this.lockOrg(tx);
      if (!(await this.campaignClaimable(tx, campaignId))) throw new CampaignGoneError(campaignId);
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
         on conflict (org_id, campaign_id) where status in ('queued', 'running')
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

  async enqueueJob(
    campaignId: string,
    customId?: string,
  ): Promise<{ acquired: true; jobId: string } | { acquired: false; runningJobId: string }> {
    return this.db.transaction(async (tx) => {
      await this.lockOrg(tx);
      if (!(await this.campaignClaimable(tx, campaignId))) throw new CampaignGoneError(campaignId);
      await this.reap(tx);
      const incumbent = await this.runningIncumbent(tx, campaignId);
      if (incumbent !== undefined) return { acquired: false, runningJobId: incumbent };
      await this.evictToFit(tx);
      const id = customId ?? randomUUID();
      const { rows } = await tx.query<{ id: string; acquired: boolean }>(
        `insert into job (id, org_id, campaign_id, status)
         values ($1, $2, $3, 'queued')
         on conflict (org_id, campaign_id) where status in ('queued', 'running')
         do update set campaign_id = excluded.campaign_id
         returning id, (xmax = 0) as acquired`,
        [id, this.orgId, campaignId],
      );
      const row = rows[0]!;
      return row.acquired
        ? { acquired: true, jobId: row.id }
        : { acquired: false, runningJobId: row.id };
    });
  }

  /**
   * A queued row past QUEUED_TTL_MS reads as failed (`lapsedAsFailed`) and the
   * fs adapter's own `startQueuedJob` refuses it for the same reason (it reads
   * through `getStoredJob` first, which performs that same conversion) — this
   * adapter's `where` must say the same thing directly, since it updates the
   * row without reading it through `lapsedAsFailed` first (finding 5). Without
   * this, an unreaped stale queued row polls as failed but a late delivery
   * could still flip it to running underneath that answer.
   *
   * PT-9c (D235): the row is also re-locked inside its own transaction and the
   * campaign is re-checked via `campaignClaimable` before the status flip — a
   * replayed Kafka message for a campaign that has since been purged must be
   * dropped (`false`) here, never started, so PT-9f's own tombstone read never
   * has to reject an already-running job. Returning `false` surfaces as
   * `{ started: false }` in `startOrDropWithSettled` (logged, offset committed,
   * no row ever flipped), which is the codebase's existing "dropped" shape — not
   * a `'failed'` settlement, which is the render-time backstop the row text
   * describes (PT-4e) and a different outcome this path must not impersonate.
   */
  async startQueuedJob(id: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query<{ campaign_id: string }>(
        `select campaign_id from job
         where id = $1 and org_id = $2 and status = 'queued' and created_at > now() - $3::interval
         for update`,
        [id, this.orgId, asInterval(QUEUED_TTL_MS)],
      );
      const row = rows[0];
      if (!row) return false;
      if (!(await this.campaignClaimable(tx, row.campaign_id))) return false;
      const updated = await tx.query<{ id: string }>(
        `update job set status = 'running', lease_expires_at = now() + $2::interval, heartbeat_at = now()
         where id = $1
         returning id`,
        [id, asInterval(LEASE_MS)],
      );
      return updated.rows.length > 0;
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
