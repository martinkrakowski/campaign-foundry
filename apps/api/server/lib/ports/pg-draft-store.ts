import type { SqlClient } from "../db/sql-client.js";
import type {
  DraftStorePort,
  LatestDraft,
  StoredDraft,
  WriteDraftOutcome,
} from "./draft-store.port.js";

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

  /**
   * `DraftStorePort.writeDraftIfCurrent` — see that doc for the shape this
   * closes. The `for update` here is the same lock `rewriteBriefInternal`
   * takes (`pg-brief-store.ts:500-503`) on the same row: whichever
   * transaction — this one or a concurrent brief save's — acquires it first
   * runs to completion before the other's own `for update` can even
   * proceed, so the `brief_version` read below is never mid-write.
   *
   * The interface's `currentRevision` parameter is deliberately not part of
   * this signature (TypeScript allows an implementation to take fewer
   * parameters than the type it satisfies, since a caller's extra argument
   * is simply ignored) — trusting a caller-supplied value here would reopen
   * exactly the race this method exists to close. It exists only for the fs
   * adapter below, which has no row to lock and so must trust a value its
   * own caller read under `withBriefLock`.
   */
  async writeDraftIfCurrent(
    campaignId: string,
    userId: string,
    state: unknown,
    baseRevision: string | null,
  ): Promise<WriteDraftOutcome> {
    return this.db.transaction(async (tx) => {
      await tx.query(`select id from campaign where org_id = $1 and id = $2 for update`, [
        this.orgId,
        campaignId,
      ]);
      const { rows: versions } = await tx.query<{ revision: string }>(
        `select revision from brief_version where campaign_id = $1 order by version desc limit 1`,
        [campaignId],
      );
      const currentRevision = versions[0]?.revision ?? null;
      if (baseRevision !== currentRevision) {
        return { ok: false, currentRevision };
      }
      const { rows } = await tx.query<{ updated_at: string }>(
        `insert into draft (campaign_id, user_id, org_id, state, base_revision, updated_at)
         values ($1, $2, $3, $4::jsonb, $5, now())
         on conflict (campaign_id, user_id) do update
           set state = excluded.state, base_revision = excluded.base_revision, updated_at = excluded.updated_at
         returning ${TO_ISO} as updated_at`,
        [campaignId, userId, this.orgId, JSON.stringify(state), baseRevision],
      );
      return { ok: true, draft: { state, baseRevision, updatedAt: rows[0]!.updated_at } };
    });
  }

  async deleteDraft(campaignId: string, userId: string): Promise<void> {
    await this.db.query(
      `delete from draft where org_id = $1 and campaign_id = $2 and user_id = $3`,
      [this.orgId, campaignId, userId],
    );
  }

  async listDraftsByRecency(userId: string): Promise<readonly LatestDraft[]> {
    const { rows } = await this.db.query<{ campaign_id: string; updated_at: string }>(
      `select campaign_id, ${TO_ISO} as updated_at
         from draft
        where org_id = $1 and user_id = $2
        order by updated_at desc`,
      [this.orgId, userId],
    );
    return rows.map((row) => ({ campaignId: row.campaign_id, updatedAt: row.updated_at }));
  }
}
