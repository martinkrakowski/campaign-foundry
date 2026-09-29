import type { SqlClient } from "../db/sql-client.js";
import type { DraftStorePort, LatestDraft, StoredDraft } from "./draft-store.port.js";

/** Renders `timestamptz` as the same ISO-8601 UTC instant shape every other
 * store answers (`PgDecisionStore`'s `to_char`, `pg-decision-store.ts:54`) —
 * `pg`/PGlite otherwise parse it into a JS `Date`, which is not what
 * `StoredDraft.updatedAt`/`LatestDraft.updatedAt` promise their callers. */
const TO_ISO = `to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/**
 * Per-user drafts as rows (PT-5d, D173, D177), one org's: the store is built
 * for an org (the registry key, `lib/ports/index.ts`), so every statement is
 * scoped to it and another org's drafts are invisible — `org_id` filters
 * every query alongside the caller's own `userId`, passed per call (mechanism
 * note: "every draft query is filtered by org_id AND the caller's user_id").
 * `campaign_id` is the real Postgres surrogate (`0014_draft.sql`'s FK to
 * `campaign`), never the slug — callers pass what `campaignMeta`/
 * `resolveCampaign` answered as `campaignId`, not `slug`.
 */
export class PgDraftStore implements DraftStorePort {
  constructor(
    private readonly db: SqlClient,
    private readonly orgId: string,
  ) {}

  async readDraft(campaignId: string, userId: string): Promise<StoredDraft | undefined> {
    const { rows } = await this.db.query<{
      state: unknown;
      base_revision: string | null;
      updated_at: string;
    }>(
      `select state, base_revision, ${TO_ISO} as updated_at
         from draft
        where org_id = $1 and campaign_id = $2 and user_id = $3`,
      [this.orgId, campaignId, userId],
    );
    const row = rows[0];
    if (!row) return undefined;
    return { state: row.state, baseRevision: row.base_revision, updatedAt: row.updated_at };
  }

  async writeDraft(
    campaignId: string,
    userId: string,
    state: unknown,
    baseRevision: string | null,
  ): Promise<StoredDraft> {
    const { rows } = await this.db.query<{ updated_at: string }>(
      `insert into draft (campaign_id, user_id, org_id, state, base_revision, updated_at)
       values ($1, $2, $3, $4::jsonb, $5, now())
       on conflict (campaign_id, user_id) do update
         set state = excluded.state, base_revision = excluded.base_revision, updated_at = excluded.updated_at
       returning ${TO_ISO} as updated_at`,
      [campaignId, userId, this.orgId, JSON.stringify(state), baseRevision],
    );
    return { state, baseRevision, updatedAt: rows[0]!.updated_at };
  }

  async deleteDraft(campaignId: string, userId: string): Promise<void> {
    await this.db.query(
      `delete from draft where org_id = $1 and campaign_id = $2 and user_id = $3`,
      [this.orgId, campaignId, userId],
    );
  }

  async latestDraft(userId: string): Promise<LatestDraft | undefined> {
    const { rows } = await this.db.query<{ campaign_id: string; updated_at: string }>(
      `select campaign_id, ${TO_ISO} as updated_at
         from draft
        where org_id = $1 and user_id = $2
        order by updated_at desc
        limit 1`,
      [this.orgId, userId],
    );
    const row = rows[0];
    if (!row) return undefined;
    return { campaignId: row.campaign_id, updatedAt: row.updated_at };
  }
}
