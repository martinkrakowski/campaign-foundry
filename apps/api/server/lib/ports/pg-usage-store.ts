import type { SqlClient } from "../db/sql-client.js";
import type { UsageRecord, UsageStorePort } from "./usage-store.port.js";

/**
 * Usage as rows (PT-7a, D175): every org shares one table, filtered by
 * `org_id` on every statement — unlike `PgDecisionStore`, this adapter is not
 * built per org, because `countThisMonth`/`quota` are asked for whichever
 * org a run or an admission check names, not always the store's own.
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
   */
  async countThisMonth(orgId: string, now: Date): Promise<number> {
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const { rows } = await this.db.query<{ count: string }>(
      `select count(*)::text as count from usage where org_id = $1 and created_at >= $2`,
      [orgId, monthStart.toISOString()],
    );
    return Number(rows[0]!.count);
  }

  async quota(orgId: string): Promise<number | null> {
    const { rows } = await this.db.query<{ monthly_generation_quota: number | null }>(
      `select monthly_generation_quota from org where id = $1`,
      [orgId],
    );
    return rows[0]?.monthly_generation_quota ?? null;
  }
}
