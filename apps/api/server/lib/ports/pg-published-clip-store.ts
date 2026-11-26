import type { ObjectKey, PublishedClipRecordPort } from "@campaignfoundry/CampaignOrchestration";
import type { SqlClient } from "../db/sql-client.js";
import type { PublishedClipRecord } from "@campaignfoundry/CampaignOrchestration";

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
       values ($1, $2::uuid, $3, $4, $5)
       on conflict (org_id, campaign_id, content_hash) do nothing
       returning key`,
      [orgId, campaignId, contentHash, key, url],
    );
    return rows.length === 0 ? "exists" : "recorded";
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
