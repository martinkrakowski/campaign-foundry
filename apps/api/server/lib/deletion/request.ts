import type { SqlClient } from "../db/sql-client.js";
import { UUID_PATTERN } from "../object-store/object-keys.js";
import { insertCampaignDeletion } from "./deletion-store.js";
import { activeJobId, removeCampaignPublishedClips } from "./purge-campaign.js";

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
 * D235's tombstone sequence. Lock order: the campaign row `for update`, and
 * nothing else locked (`pg-job-store.ts:121-146`, item iii); `job` is read
 * unlocked AFTER the lock, which is safe because every active `job` row is
 * written under the campaign row `for share`. Whichever of a claim and the
 * check transaction commits first decides.
 *
 * Three phases (PT-4k):
 *
 *  1. A read-only check transaction: the campaign exists, is not tombstoned,
 *     passes `mayDelete` and has no active job — so a forbidden caller, a
 *     missing/cross-org/tombstoned campaign or an active-job refusal never
 *     unpublishes a clip.
 *  2. The published clips are unpublished OUTSIDE any transaction (D231: no
 *     object-store call is made while a transaction is held —
 *     `purge-campaign.ts`'s own purge path says the same). A public object
 *     leaves first, then its `published_clip` row; a failure here throws
 *     before the tombstone, leaving the request fully retryable.
 *  3. The tombstone transaction: `deleted_at` and the `deletion` row, the
 *     campaign row re-locked `for update` and re-checked live AND jobless so
 *     two concurrent requests still answer one `requested` and one `gone`
 *     (the original single-transaction guarantee, kept) and a job that
 *     became active in the gap is refused here rather than tombstoned
 *     through — the same check/claim ordering as phase 1: every active
 *     `job` row is written under the campaign row `for share`, which this
 *     `for update` waits on, so a claim that committed after phase 1 is
 *     visible by the time this transaction reads. The refusal skips the
 *     pass-2 unpublish below, so a still-running job's own publishes are
 *     never swept by the request that refused it.
 *
 * A failure at any step leaves neither `deleted_at` nor a `deletion` row.
 * After the tombstone commits, one more unpublish pass closes the window
 * where a concurrent export published a clip between phases 2 and 3.
 */
export async function requestCampaignDeletion(
  db: SqlClient,
  request: CampaignDeletionRequest,
): Promise<CampaignDeletionOutcome> {
  // The `::uuid` cast below would raise 22P02 on anything else.
  if (!UUID_PATTERN.test(request.campaignId)) return { outcome: "gone" };
  const checked = await db.transaction(async (tx) => {
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
    if (row === undefined || row.deleted_at !== null) return { outcome: "gone" } as const;
    if (!request.mayDelete(row.team_id)) return { outcome: "forbidden" } as const;
    const jobId = await activeJobId(tx, request.orgId, row.slug, row.id);
    if (jobId !== undefined) return { outcome: "active-job", jobId } as const;
    return { outcome: "checked" as const, campaignId: row.id };
  });
  if (checked.outcome !== "checked") return checked;

  // Pass 1: the campaign's own public clips leave before anything is
  // tombstoned, so a failed removal is a plain retry.
  await removeCampaignPublishedClips(db, request.orgId, checked.campaignId);

  const result = await db.transaction(async (tx) => {
    const { rows } = await tx.query<{ id: string; slug: string; deleted_at: Date | null }>(
      `select id, slug, deleted_at from campaign
         where org_id = $1 and id = $2::uuid for update`,
      [request.orgId, checked.campaignId],
    );
    const row = rows[0];
    if (row === undefined || row.deleted_at !== null) return { outcome: "gone" } as const;
    // Phase 1 released the campaign lock, so a job may have claimed the
    // campaign in the gap. Re-run the refusal under the re-taken `for update`
    // (same check/claim ordering as the first transaction): a campaign with
    // an active job is refused here — no tombstone, no `deletion` row, and
    // the pass-2 unpublish below never runs. Pass 1 has already removed this
    // campaign's clips by then; that is accepted — the clip objects and rows
    // stay removed and are simply re-created on the next explicit export.
    const jobId = await activeJobId(tx, request.orgId, row.slug, row.id);
    if (jobId !== undefined) return { outcome: "active-job", jobId } as const;
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
    return { outcome: "requested", deletionId } as const;
  });
  if (result.outcome !== "requested") return result;

  // Pass 2 (after the commit, `tx` long closed): a concurrent export may have
  // published a clip between the two passes; this one closes that window.
  await removeCampaignPublishedClips(db, request.orgId, checked.campaignId);
  return result;
}
