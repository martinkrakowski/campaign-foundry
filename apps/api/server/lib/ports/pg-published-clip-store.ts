import type { ObjectKey, PublishedClipRecordPort } from "@campaignfoundry/CampaignOrchestration";
import type { SqlClient } from "../db/sql-client.js";
import type { PublishedClipRecord } from "@campaignfoundry/CampaignOrchestration";

/**
 * Thrown when a clip is offered for a campaign that is not live (tombstoned
 * by soft delete, or no row at all): an in-flight export must not record a
 * published clip on a campaign whose deletion has begun. The caller —
 * `PublishAdClipUseCase` — removes the object it just published and reports
 * the refusal.
 */
export class PublishedClipRecordRefusedError extends Error {
  constructor() {
    super("Refusing to record a published clip for a campaign that is not live.");
    this.name = "PublishedClipRecordRefusedError";
  }
}

/**
 * The published-clip ledger as rows (PT-4k, D175): one table shared by every
 * org, filtered by `org_id = $1` on every statement — like `PgUsageStore`,
 * this adapter is not built per org, because the delete use case names the
 * org per call.
 *
 * `record` is idempotent on `(org_id, campaign_id, content_hash)` via
 * `on conflict do nothing`: the same bytes never publish twice, and a caller
 * that loses the race reads the winner's row through `find`. A duplicate
 * `key` over a DIFFERENT `(org_id, campaign_id, content_hash)` still hits the
 * `key` unique constraint and throws — a refusal, never a silent `"exists"`.
 *
 * `record` is conditional on the campaign being LIVE (`deleted_at is null`,
 * CFAR6-record): an export that races a campaign's tombstone must not leave a
 * published-clip fact behind, so when nothing was inserted the liveness check
 * decides between `"exists"` and the `PublishedClipRecordRefusedError`
 * refusal. A bare delete with rows is refused by the schema's FK anyway —
 * this closes the soft-delete gap the FK does not see.
 */
export class PgPublishedClipStore implements PublishedClipRecordPort {
  constructor(private readonly db: SqlClient) {}

  async record(
    orgId: string,
    campaignId: string,
    key: ObjectKey,
    url: string,
    contentHash: string,
  ): Promise<"recorded" | "exists"> {
    const { rows } = await this.db.query<{ key: string }>(
      `insert into published_clip (org_id, campaign_id, content_hash, key, url)
       select $1, $2::uuid, $3, $4, $5
       where exists (
         select 1 from campaign where id = $2::uuid and deleted_at is null
       )
       on conflict (org_id, campaign_id, content_hash) do nothing
       returning key`,
      [orgId, campaignId, contentHash, key, url],
    );
    if (rows.length > 0) return "recorded";
    // Nothing inserted: either the content hash is already recorded or the
    // campaign is not live (tombstoned or absent) — the `where exists` gate
    // refused the row in the same snapshot the insert read. Liveness decides:
    // never answer `"exists"` for a campaign whose export must not gain a
    // record.
    const existing = await this.find(orgId, campaignId, contentHash);
    if (existing !== undefined) return "exists";
    throw new PublishedClipRecordRefusedError();
  }

  async find(
    orgId: string,
    campaignId: string,
    contentHash: string,
  ): Promise<PublishedClipRecord | undefined> {
    const { rows } = await this.db.query<{ key: string; url: string }>(
      `select key, url from published_clip
        where org_id = $1 and campaign_id = $2::uuid and content_hash = $3`,
      [orgId, campaignId, contentHash],
    );
    const row = rows[0];
    return row === undefined ? undefined : { key: row.key as ObjectKey, url: row.url };
  }

  async listForCampaign(
    orgId: string,
    campaignId: string,
  ): Promise<readonly PublishedClipRecord[]> {
    const { rows } = await this.db.query<{ key: string; url: string }>(
      `select key, url from published_clip where org_id = $1 and campaign_id = $2::uuid`,
      [orgId, campaignId],
    );
    return rows.map((row) => ({ key: row.key as ObjectKey, url: row.url }));
  }

  async remove(orgId: string, key: ObjectKey): Promise<void> {
    await this.db.query(`delete from published_clip where org_id = $1 and key = $2`, [orgId, key]);
  }
}
