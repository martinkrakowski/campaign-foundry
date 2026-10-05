import type { SqlClient } from "../db/sql-client.js";
import { UUID_PATTERN } from "../object-store/object-keys.js";
import { insertCampaignDeletion } from "./deletion-store.js";
import { activeJobId } from "./purge-campaign.js";

export interface CampaignDeletionRequest {
  readonly orgId: string;
  /** The campaign's uuid as `resolveCampaign` answered it (`{ campaignId }`). */
  readonly campaignId: string;
  readonly requestedBy: string;
  /** D234, decided on the LOCKED row's `team_id` — the route passes `canAssignTeam`. */
  readonly mayDelete: (teamId: string | null) => boolean;
  /** `purgeGraceHours()`. */
  readonly graceHours: number;
}

export type CampaignDeletionOutcome =
  | { readonly outcome: "requested"; readonly deletionId: string }
  | { readonly outcome: "gone" }
  | { readonly outcome: "forbidden" }
  | { readonly outcome: "active-job"; readonly jobId: string };

/**
 * D235's tombstone transaction. Lock order: the campaign row `for update`, and
 * nothing else locked (`pg-job-store.ts:121-146`, item iii); `job` is read
 * unlocked AFTER the lock, which is safe because every active `job` row is
 * written under the campaign row `for share`. Whichever of a claim and this
 * transaction commits first decides. One transaction: a failure at any step
 * leaves neither `deleted_at` nor a `deletion` row.
 */
export async function requestCampaignDeletion(
  db: SqlClient,
  request: CampaignDeletionRequest,
): Promise<CampaignDeletionOutcome> {
  // The `::uuid` cast below would raise 22P02 on anything else.
  if (!UUID_PATTERN.test(request.campaignId)) return { outcome: "gone" };
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<{
      id: string;
      slug: string;
      team_id: string | null;
      deleted_at: Date | null;
    }>(
      `select id, slug, team_id, deleted_at from campaign
         where org_id = $1 and id = $2::uuid for update`,
      [request.orgId, request.campaignId.toLowerCase()],
    );
    const row = rows[0];
    if (row === undefined || row.deleted_at !== null) return { outcome: "gone" };
    if (!request.mayDelete(row.team_id)) return { outcome: "forbidden" };
    const jobId = await activeJobId(tx, request.orgId, row.slug, row.id);
    if (jobId !== undefined) return { outcome: "active-job", jobId };
    await tx.query(
      `update campaign set deleted_at = now(), deleted_by = $3
         where org_id = $1 and id = $2::uuid`,
      [request.orgId, row.id, request.requestedBy],
    );
    const grace = `${request.graceHours} hours`;
    const deletionId = await insertCampaignDeletion(tx, {
      orgId: request.orgId,
      campaignId: row.id,
      requestedBy: request.requestedBy,
      grace,
    });
    return { outcome: "requested", deletionId };
  });
}
