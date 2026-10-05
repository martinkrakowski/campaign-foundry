import type { SqlClient } from "../db/sql-client.js";

/** How long a sweeper's claim on a `deletion` row lasts without the row being
 * finished. Long enough to cover an S3 `deletePrefix` over a large campaign's
 * renders; short enough that a crashed sweeper's row is retried well inside an
 * operator's patience. No existing constant to mirror — this is a new budget,
 * not a borrowed one (PT-6a's job `LEASE_MS` is 60s for a heartbeat ping, not an
 * unattended multi-step purge). */
export const PURGE_LEASE_MS = 5 * 60_000;

export interface DeletionRow {
  readonly id: string;
  readonly orgId: string | null;
  readonly kind: "campaign" | "org" | "user";
  readonly subject: string;
  readonly requestedBy: string;
  readonly notBefore: number;
  readonly attempts: number;
}

function asInterval(ms: number): string {
  return `${ms} milliseconds`;
}

interface DeletionRowSql {
  id: string;
  org_id: string | null;
  kind: "campaign" | "org" | "user";
  subject: string;
  requested_by: string;
  not_before: Date;
  attempts: number;
}

function mapRow(row: DeletionRowSql): DeletionRow {
  return {
    id: row.id,
    orgId: row.org_id,
    kind: row.kind,
    subject: row.subject,
    requestedBy: row.requested_by,
    notBefore: row.not_before.getTime(),
    attempts: row.attempts,
  };
}

/**
 * Claim the oldest due, unclaimed `deletion` row, with a lease (D231, PT-9-4):
 * the UPDATE and its own `SELECT … FOR UPDATE SKIP LOCKED` run in one
 * transaction, committed before any purge work begins, so two sweepers racing
 * this call can never both claim the same row. `skip locked` (not `for update`
 * alone) is what lets a second sweeper move on to the NEXT due row instead of
 * queueing behind the first sweeper's whole purge.
 */
export async function claimDue(db: SqlClient): Promise<DeletionRow | undefined> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<DeletionRowSql>(
      `update deletion
          set claimed_until = now() + $1::interval, attempts = attempts + 1
        where id = (
          select id from deletion
           where not_before <= now()
             and purged_at is null
             and (claimed_until is null or claimed_until < now())
           order by not_before
           for update skip locked
           limit 1
        )
        returning id, org_id, kind, subject, requested_by, not_before, attempts`,
      [asInterval(PURGE_LEASE_MS)],
    );
    return rows[0] ? mapRow(rows[0]) : undefined;
  });
}

/**
 * Record a caught (non-crash) failure for diagnosis, WITHOUT releasing the
 * lease. This is deliberate, not an oversight: `claimDue` orders by `not_before`,
 * oldest first, so a lease that is cleared immediately on every failure lets a
 * single permanently-broken row (a dead S3 endpoint, an unreadable fs root) be
 * re-claimed on the very next `sweep()` loop iteration forever — head-of-line
 * starvation that would stop every OTHER due row from ever being reached, in
 * every sweep, until an operator intervenes. Leaving `claimed_until` standing
 * means the row simply waits out its own `PURGE_LEASE_MS` like a crashed
 * sweeper's row does (D231's own crash semantics: "re-claimable once its lease
 * lapses") — a real but bounded delay, not an infinite retry storm.
 * `PURGE_LEASE_MS` (5 min) is well under PT-9q's cron interval (`yarn
 * purge:sweep` every 10 min), so "retry on the next sweep" (D232 step 1's own
 * words) still holds in practice.
 */
export async function recordFailure(db: SqlClient, id: string, message: string): Promise<void> {
  await db.query(`update deletion set last_error = $2 where id = $1`, [id, message]);
}

/** Due, unclaimed rows, oldest first — for `bin/purge.ts sweep --dry-run`. Never claims. */
export async function listDue(db: SqlClient): Promise<readonly DeletionRow[]> {
  const { rows } = await db.query<DeletionRowSql>(
    `select id, org_id, kind, subject, requested_by, not_before, attempts
       from deletion
      where not_before <= now()
        and purged_at is null
        and (claimed_until is null or claimed_until < now())
      order by not_before`,
  );
  return rows.map(mapRow);
}
