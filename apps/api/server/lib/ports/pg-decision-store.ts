import { SAFE_ID_PATTERN } from "@campaignfoundry/CampaignOrchestration";
import { hashBytes } from "../brief-files.js";
import type { SqlClient } from "../db/sql-client.js";
import type {
  DecisionMap,
  DecisionRecord,
  DecisionStorePort,
  StoredDecisions,
  Verdict,
} from "./decision-store.port.js";

interface DecisionRow {
  asset_key: string;
  verdict: Verdict;
  actor: string;
  decided_at: Date;
  run: string;
}

/**
 * The revision of a decision map: the SHA-256 of the bytes the file store writes
 * for it, so the same decisions have the same revision in either store, and
 * decisions imported from files (PT-8) keep theirs.
 */
function revisionOf(decisions: DecisionMap): string {
  return hashBytes(Buffer.from(`${JSON.stringify(decisions, null, 2)}\n`, "utf8"));
}

/**
 * Decisions as rows (PT-3, D173), one org's: the store is built for an org, so
 * every statement is scoped to it and another org's decisions are invisible.
 */
export class PgDecisionStore implements DecisionStorePort {
  constructor(
    private readonly db: SqlClient,
    private readonly orgId: string,
  ) {}

  async readDecisions(campaignId: string): Promise<StoredDecisions> {
    if (!SAFE_ID_PATTERN.test(campaignId)) return { decisions: {}, revision: null };
    return this.db.transaction(async (tx) => {
      const set = await tx.query<{ revision: string }>(
        "select revision from decision_set where org_id = $1 and campaign_id = $2",
        [this.orgId, campaignId],
      );
      const rows = await tx.query<DecisionRow>(
        "select asset_key, verdict, actor, decided_at, run from decision where org_id = $1 and campaign_id = $2 order by asset_key",
        [this.orgId, campaignId],
      );
      // A null prototype, as the file store's: a `__proto__` key is a key.
      const decisions = Object.create(null) as Record<string, DecisionRecord>;
      for (const row of rows.rows) {
        decisions[row.asset_key] = {
          verdict: row.verdict,
          actor: row.actor,
          at: row.decided_at.toISOString(),
          run: row.run,
        };
      }
      return { decisions, revision: set.rows[0]?.revision ?? null };
    });
  }

  async writeDecisions(campaignId: string, decisions: DecisionMap): Promise<string> {
    if (!SAFE_ID_PATTERN.test(campaignId)) {
      throw new Error(`Decisions campaign id ${JSON.stringify(campaignId)} is not a safe id.`);
    }
    const revision = revisionOf(decisions);
    const rows = Object.entries(decisions).map(([key, record]) => ({
      asset_key: key,
      verdict: record.verdict,
      actor: record.actor,
      decided_at: record.at,
      run: record.run,
    }));
    await this.db.transaction(async (tx) => {
      await tx.query("delete from decision where org_id = $1 and campaign_id = $2", [
        this.orgId,
        campaignId,
      ]);
      // One statement for the whole map (up to MAX_DECISIONS rows), from a JSON array.
      await tx.query(
        `insert into decision (org_id, campaign_id, asset_key, verdict, actor, decided_at, run)
         select $1, $2, r.asset_key, r.verdict, r.actor, r.decided_at, r.run
         from jsonb_to_recordset($3::jsonb)
           as r(asset_key text, verdict text, actor text, decided_at timestamptz, run text)`,
        [this.orgId, campaignId, JSON.stringify(rows)],
      );
      await tx.query(
        `insert into decision_set (org_id, campaign_id, revision) values ($1, $2, $3)
         on conflict (org_id, campaign_id) do update set revision = excluded.revision`,
        [this.orgId, campaignId, revision],
      );
    });
    return revision;
  }
}
