import { SAFE_ID_PATTERN } from "@campaignfoundry/CampaignOrchestration";
import { hashBytes } from "../brief-files.js";
import type { SqlClient, SqlQuery } from "../db/sql-client.js";
import { ReportConflictError, type ReportStorePort } from "./report-store.port.js";

/**
 * Reports as rows (PT-3, D169), one org's: the store is built for an org, so
 * every statement is scoped to it and another org's reports are invisible.
 */
export class PgReportStore implements ReportStorePort {
  constructor(
    private readonly db: SqlClient,
    private readonly orgId: string,
  ) {}

  async readReport(campaignId: string): Promise<unknown> {
    if (!SAFE_ID_PATTERN.test(campaignId)) return undefined;
    const { rows } = await this.db.query<{ body: string }>(
      "select body from report where org_id = $1 and campaign_id = $2",
      [this.orgId, campaignId],
    );
    const row = rows[0];
    if (!row) return undefined;
    // A stored body that is not JSON rejects: it is not the same as absence,
    // exactly as the file store's unparsable report does.
    return JSON.parse(row.body);
  }

  async getRevision(campaignId: string): Promise<string | undefined> {
    if (!SAFE_ID_PATTERN.test(campaignId)) return undefined;
    const { rows } = await this.db.query<{ revision: string }>(
      "select revision from report where org_id = $1 and campaign_id = $2",
      [this.orgId, campaignId],
    );
    return rows[0]?.revision;
  }

  async writeReport(
    campaignId: string,
    payload: string,
    expectedRevision?: string | null,
    fence?: { runId: string },
  ): Promise<string> {
    if (!SAFE_ID_PATTERN.test(campaignId)) {
      throw new Error(`Report campaign id ${JSON.stringify(campaignId)} is not a safe id.`);
    }
    // The same digest the file store takes of the bytes it writes (D80): equal
    // payloads get equal revisions in either store, so a PT-8 import keeps it.
    const revision = hashBytes(Buffer.from(payload, "utf8"));
    await this.db.transaction((tx) =>
      this.claim(tx, campaignId, payload, revision, expectedRevision),
    );
    return `reports/${campaignId}.json`;
  }

  /**
   * Write the row, and with an expected revision, only if it is still the
   * stored one. The update's row lock (or the insert's unique key, when none
   * was recorded) makes the compare and the swap one step: of two writes from
   * the same read, in any process, the second finds the revision moved and throws.
   */
  private async claim(
    tx: SqlQuery,
    campaignId: string,
    payload: string,
    revision: string,
    expected: string | null | undefined,
  ): Promise<void> {
    const key = [this.orgId, campaignId];
    if (expected === undefined) {
      await tx.query(
        `insert into report (org_id, campaign_id, body, revision, updated_at)
         values ($1, $2, $3, $4, now())
         on conflict (org_id, campaign_id)
           do update set body = excluded.body, revision = excluded.revision, updated_at = excluded.updated_at`,
        [...key, payload, revision],
      );
      return;
    }
    const claimed =
      expected === null
        ? await tx.query(
            `insert into report (org_id, campaign_id, body, revision, updated_at)
             values ($1, $2, $3, $4, now())
             on conflict (org_id, campaign_id) do nothing returning 1`,
            [...key, payload, revision],
          )
        : await tx.query(
            `update report set body = $4, revision = $5, updated_at = now()
             where org_id = $1 and campaign_id = $2 and revision = $3 returning 1`,
            [...key, expected, payload, revision],
          );
    if (claimed.rows.length === 0) {
      const current = await tx.query<{ revision: string }>(
        "select revision from report where org_id = $1 and campaign_id = $2",
        key,
      );
      throw new ReportConflictError(campaignId, current.rows[0]?.revision);
    }
  }
}
