import type { SqlClient } from "../db/sql-client.js";
import { RESERVATION_TTL_MS, type UsageRecord, type UsageStorePort } from "./usage-store.port.js";

/**
 * Usage as rows (PT-7a, D175): every org shares one table, filtered by
 * `org_id` on every statement — unlike `PgDecisionStore`, this adapter is not
 * built per org, because `countThisMonth`/`quota` are asked for whichever
 * org a run or an admission check names, not always the store's own.
 *
 * Quota reservations (PT-7a2): concurrent callers reserve a slot inside an
 * advisory-locked transaction before calling a provider, settling it to
 * 'recorded' on success or releasing it (delete) on failure.
 */
export class PgUsageStore implements UsageStorePort {
  constructor(private readonly db: SqlClient) {}

  async record(usage: UsageRecord): Promise<void> {
    await this.db.query(
      `insert into usage (org_id, provider, model, units, key_owner)
       values ($1, $2, $3, $4, $5)`,
      [usage.orgId, usage.provider, usage.model, usage.units, usage.keyOwner],
    );
  }

  /**
   * The month boundary is computed here, in UTC, from `now`'s own fields —
   * never left to the database session's timezone — so "this calendar month"
   * means the same instant whatever the server or PGlite is configured with.
   *
   * Counts recorded rows plus any unexpired reservations within RESERVATION_TTL_MS.
   */
  async countThisMonth(orgId: string, now: Date): Promise<number> {
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const cutoff = new Date(now.getTime() - RESERVATION_TTL_MS);
    const { rows } = await this.db.query<{ count: string }>(
      `select count(*)::text as count from usage
       where org_id = $1 and created_at >= $2
         and (status = 'recorded' or (status = 'reserved' and created_at >= $3))`,
      [orgId, monthStart.toISOString(), cutoff.toISOString()],
    );
    return Number(rows[0]!.count);
  }

  /**
   * `null` is "no `org` row" too — indistinguishable from an explicit unlimited
   * quota by `??` alone — so an org id nothing admitted (a typo, a deleted org, a
   * row this migration never seeded) read as unlimited instead of refused (fix
   * round, reviewer finding). No row now refuses: quota 0, not null.
   */
  async quota(orgId: string): Promise<number | null> {
    const { rows } = await this.db.query<{ monthly_generation_quota: number | null }>(
      `select monthly_generation_quota from org where id = $1`,
      [orgId],
    );
    if (rows.length === 0) return 0;
    return rows[0].monthly_generation_quota;
  }

  /**
   * Reserve one generation slot under an advisory transaction lock (PT-7a2, D175).
   * Missing org means quota 0 (refused). Returns reservation id or null at quota.
   */
  async reserve(orgId: string, now: Date = new Date()): Promise<string | null> {
    return this.db.transaction(async (tx) => {
      await tx.query("select pg_advisory_xact_lock(hashtext('usage:' || $1))", [orgId]);

      const { rows: orgRows } = await tx.query<{ monthly_generation_quota: number | null }>(
        `select monthly_generation_quota from org where id = $1`,
        [orgId],
      );
      if (orgRows.length === 0) return null;
      const quota = orgRows[0].monthly_generation_quota;

      if (quota !== null) {
        const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        const cutoff = new Date(now.getTime() - RESERVATION_TTL_MS);
        const { rows: countRows } = await tx.query<{ count: string }>(
          `select count(*)::text as count from usage
           where org_id = $1 and created_at >= $2
             and (status = 'recorded' or (status = 'reserved' and created_at >= $3))`,
          [orgId, monthStart.toISOString(), cutoff.toISOString()],
        );
        const count = Number(countRows[0]!.count);
        if (count >= quota) return null;
      }

      const { rows: insertRows } = await tx.query<{ id: string }>(
        `insert into usage (org_id, status) values ($1, 'reserved') returning id`,
        [orgId],
      );
      return String(insertRows[0]!.id);
    });
  }

  /** Settle a reserved slot into a recorded row with generation details. */
  async settle(id: string, record: UsageRecord): Promise<void> {
    const { rows } = await this.db.query<{ id: string }>(
      `update usage
       set status = 'recorded',
           provider = $2,
           model = $3,
           units = $4,
           key_owner = $5
       where id = $1 and org_id = $6 and status = 'reserved'
       returning id`,
      [id, record.provider, record.model, record.units, record.keyOwner, record.orgId],
    );
    if (rows.length === 0) {
      await this.record(record);
    }
  }

  /** Release an unused reservation by deleting the reserved row. */
  async release(id: string): Promise<void> {
    await this.db.query(`delete from usage where id = $1 and status = 'reserved'`, [id]);
  }
}
