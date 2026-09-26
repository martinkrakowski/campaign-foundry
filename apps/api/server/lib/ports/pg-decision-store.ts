import { SAFE_ID_PATTERN } from "@campaignfoundry/CampaignOrchestration";
import { hashBytes } from "../brief-files.js";
import type { SqlClient, SqlQuery } from "../db/sql-client.js";
import {
  DecisionConflictError,
  isDecisionTime,
  type DecisionMap,
  type DecisionRecord,
  type DecisionStorePort,
  type StoredDecisions,
} from "./decision-store.port.js";
import { JobLeaseLostError } from "./job-store.port.js";

/**
 * The revision of a decision map: the SHA-256 of the bytes the file store writes
 * for it, so the same decisions have the same revision in either store, and
 * decisions imported from files (PT-8) keep theirs. The bytes depend on key
 * order, so rows keep the order they were written in (`ordinal`).
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
    // One statement, so the revision and the rows come from one snapshot: a save
    // committing in between can never pair one version's rows with another's revision.
    // The time is rendered in `toISOString`'s form, the only form a store accepts.
    const { rows } = await this.db.query<{
      revision: string | null;
      decisions: {
        asset_key: string;
        verdict: DecisionRecord["verdict"];
        actor: string;
        at: string;
        run: string;
      }[];
    }>(
      `select
         (select revision from decision_set where org_id = $1 and campaign_id = $2) as revision,
         coalesce(
           (select json_agg(json_build_object(
                     'asset_key', asset_key, 'verdict', verdict, 'actor', actor, 'run', run,
                     'at', to_char(decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
                   order by ordinal)
              from decision where org_id = $1 and campaign_id = $2),
           '[]'::json) as decisions`,
      [this.orgId, campaignId],
    );
    const row = rows[0]!;
    // A null prototype, as the file store's: a `__proto__` key is a key.
    const decisions = Object.create(null) as Record<string, DecisionRecord>;
    for (const d of row.decisions) {
      decisions[d.asset_key] = { verdict: d.verdict, actor: d.actor, at: d.at, run: d.run };
    }
    return { decisions, revision: row.revision };
  }

  async writeDecisions(
    campaignId: string,
    decisions: DecisionMap,
    expectedRevision?: string | null,
    fence?: { runId: string },
  ): Promise<string> {
    if (!SAFE_ID_PATTERN.test(campaignId)) {
      throw new Error(`Decisions campaign id ${JSON.stringify(campaignId)} is not a safe id.`);
    }
    const rows = Object.entries(decisions).map(([key, record], ordinal) => {
      if (!isDecisionTime(record.at)) {
        throw new Error(
          `Decision "${key}" has a time that is not an ISO-8601 UTC instant: ${JSON.stringify(record.at)}.`,
        );
      }
      return {
        asset_key: key,
        ordinal,
        verdict: record.verdict,
        actor: record.actor,
        decided_at: record.at,
        run: record.run,
      };
    });
    const revision = revisionOf(decisions);
    await this.db.transaction(async (tx) => {
      if (fence !== undefined) {
        const { rows: fenceRows } = await tx.query(
          `select 1 from job where id = $1 and org_id = $2 and campaign_id = $3 and status = 'running' and lease_expires_at > now() for share`,
          [fence.runId, this.orgId, campaignId],
        );
        if (fenceRows.length === 0) {
          throw new JobLeaseLostError(fence.runId);
        }
      }
      await this.claim(tx, campaignId, revision, expectedRevision);
      await tx.query("delete from decision where org_id = $1 and campaign_id = $2", [
        this.orgId,
        campaignId,
      ]);
      // One statement for the whole map (up to MAX_DECISIONS rows), from a JSON array.
      await tx.query(
        `insert into decision (org_id, campaign_id, asset_key, ordinal, verdict, actor, decided_at, run)
         select $1, $2, r.asset_key, r.ordinal, r.verdict, r.actor, r.decided_at, r.run
         from jsonb_to_recordset($3::jsonb)
           as r(asset_key text, ordinal int, verdict text, actor text, decided_at timestamptz, run text)`,
        [this.orgId, campaignId, JSON.stringify(rows)],
      );
    });
    return revision;
  }

  /**
   * Record the new revision, and with an expected one, only if it is still the
   * stored one. The update's row lock (or the insert's unique key, when none was
   * recorded) makes the compare and the swap one step: of two saves from the same
   * read, in any processes, the second finds the revision moved and throws.
   */
  private async claim(
    tx: SqlQuery,
    campaignId: string,
    revision: string,
    expected: string | null | undefined,
  ): Promise<void> {
    const key = [this.orgId, campaignId];
    if (expected === undefined) {
      await tx.query(
        `insert into decision_set (org_id, campaign_id, revision) values ($1, $2, $3)
         on conflict (org_id, campaign_id) do update set revision = excluded.revision`,
        [...key, revision],
      );
      return;
    }
    const claimed =
      expected === null
        ? await tx.query(
            `insert into decision_set (org_id, campaign_id, revision) values ($1, $2, $3)
             on conflict (org_id, campaign_id) do nothing returning 1`,
            [...key, revision],
          )
        : await tx.query(
            "update decision_set set revision = $4 where org_id = $1 and campaign_id = $2 and revision = $3 returning 1",
            [...key, expected, revision],
          );
    if (claimed.rows.length === 0) {
      const current = await tx.query<{ revision: string }>(
        "select revision from decision_set where org_id = $1 and campaign_id = $2",
        key,
      );
      throw new DecisionConflictError(campaignId, current.rows[0]?.revision ?? null);
    }
  }
}
