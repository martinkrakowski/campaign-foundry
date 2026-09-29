import type { SqlClient } from "../db/sql-client.js";
import type { LastOpenedPointer, LastOpenedStorePort } from "./last-opened-store.port.js";

/** Renders `timestamptz` as the same ISO-8601 UTC instant shape every other
 * store answers (`PgDecisionStore`'s `to_char`, `pg-decision-store.ts:54`;
 * `PgDraftStore`'s copy) — `pg`/PGlite otherwise parse it into a JS `Date`,
 * which is not what `LastOpenedPointer.updatedAt` promises its callers. */
const TO_ISO = `to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/**
 * The last-opened pointer as rows (PT-5e, D173, D180), one org's: the store is
 * built for an org (the registry key, `lib/ports/index.ts`), so every statement
 * is scoped to it and another org's pointers are invisible — `org_id` filters
 * every query alongside the caller's own `user_id`, passed per call.
 *
 * The pointer's campaign is NOT resolved here. A pointer to a campaign that has
 * since been deleted cannot exist (the FK cascades), and a pointer to a
 * team-hidden one is a real row that must still read as "no pointer" — the ROUTE
 * decides that, through `BriefStorePort.campaignMeta`, which already answers
 * `undefined` for hidden and missing alike (PT-2d). Deciding visibility in two
 * places is how a hidden campaign starts answering differently from a deleted
 * one; this store therefore stores and returns, and knows nothing of teams.
 */
export class PgLastOpenedStore implements LastOpenedStorePort {
  constructor(
    private readonly db: SqlClient,
    private readonly orgId: string,
  ) {}

  async read(userId: string): Promise<LastOpenedPointer | undefined> {
    const { rows } = await this.db.query<{ campaign_id: string; updated_at: string }>(
      `select campaign_id, ${TO_ISO} as updated_at
         from last_opened
        where org_id = $1 and user_id = $2`,
      [this.orgId, userId],
    );
    const row = rows[0];
    if (!row) return undefined;
    return { campaignId: row.campaign_id, updatedAt: row.updated_at };
  }

  async write(campaignId: string, userId: string): Promise<LastOpenedPointer> {
    // One row per (org, user): opening a second campaign replaces the pointer
    // in place, the same upsert `PgDraftStore.writeDraft` uses for one draft
    // per (campaign, user). A pointer is not an audit trail, unlike
    // `brief_version` or `decision` (D173).
    const { rows } = await this.db.query<{ updated_at: string }>(
      `insert into last_opened (org_id, user_id, campaign_id, updated_at)
       values ($1, $2, $3, now())
       on conflict (org_id, user_id) do update
         set campaign_id = excluded.campaign_id, updated_at = excluded.updated_at
       returning ${TO_ISO} as updated_at`,
      [this.orgId, userId, campaignId],
    );
    return { campaignId, updatedAt: rows[0]!.updated_at };
  }
}
