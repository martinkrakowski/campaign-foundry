import { rm } from "node:fs/promises";
import type { SqlClient } from "../db/sql-client.js";
import { objectStore } from "../config.js";
import { objectStoreClient } from "../object-store/index.js";
import { orgPrefix } from "../object-store/object-keys.js";
import { storageRoots } from "../run-environment.js";
import { LOCAL_TENANT } from "../tenant.js";
import { insertCampaignDeletion, recordFailure, type DeletionRow } from "./deletion-store.js";
import { markPurged } from "./purge-campaign.js";
import { requestCampaignDeletion } from "./request.js";

export type OrgDeletionOutcome = "requested" | "already-requested";
export interface OrgDeletionRequest {
  readonly orgId: string;
  readonly requestedBy: string;
}
export const ORG_BLOCKED_MESSAGE = "an active job exists for a campaign of this org";
const LEFTOVER_TABLES = [
  "decision",
  "decision_set",
  "report",
  "pool",
  "job",
  "asset",
  "draft",
  "last_opened",
] as const;

function refuseLocal(orgId: string): void {
  if (orgId === LOCAL_TENANT.orgId) {
    throw new Error('org "local" can never be deleted.');
  }
}

/**
 * D241 step 1 (request): tombstone the org row and create its `kind = 'org'`
 * deletion row — the work item a sweeper will later claim. One transaction: a
 * failure at any step leaves neither `deleted_at` nor a deletion row, so a
 * retry is safe and converges (D241 step 1 is idempotent: a second call sees
 * `deleted_at` set and answers `"already-requested"`).
 */
export async function requestOrgDeletion(
  db: SqlClient,
  request: OrgDeletionRequest,
): Promise<OrgDeletionOutcome> {
  refuseLocal(request.orgId);
  return db.transaction(async (tx): Promise<OrgDeletionOutcome> => {
    const { rows } = await tx.query<{ deleted_at: Date | null }>(
      `select deleted_at from org where id = $1 for update`,
      [request.orgId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error(`unknown org "${request.orgId}"`);
    if (row.deleted_at !== null) return "already-requested";
    await tx.query(`update org set deleted_at = now() where id = $1`, [request.orgId]);
    await tx.query(
      `insert into deletion (org_id, kind, subject, requested_by, not_before)
         values ($1, 'org', $1, $2, now())`,
      [request.orgId, request.requestedBy],
    );
    return "requested";
  });
}

/**
 * D241 step 2: enqueue a campaign purge for every live campaign of the org, then
 * back-fill any tombstoned campaign that lacks one. Idempotent (D241 step 2):
 * a re-run finds no live campaigns and no orphans, both loops are no-ops.
 *
 * **@returns** `true` when some campaign could not be queued because a run is
 * active (OD6) — the caller records a failure and answers `"retry"`. An
 * `active-job` outcome never touches the campaign row, so a re-run once the job
 * settles re-tries that campaign through `requestCampaignDeletion` (D235).
 */
export async function queueCampaignPurges(
  db: SqlClient,
  orgId: string,
  requestedBy: string,
): Promise<boolean> {
  let blocked = false;
  const { rows } = await db.query<{ id: string }>(
    `select id::text as id from campaign where org_id = $1 and deleted_at is null order by id`,
    [orgId],
  );
  for (const { id: campaignId } of rows) {
    const result = await requestCampaignDeletion(db, {
      orgId,
      campaignId,
      requestedBy,
      mayDelete: () => true,
      graceHours: 0,
    });
    if (result.outcome === "active-job") blocked = true;
  }
  const { rows: orphans } = await db.query<{ id: string }>(
    `select c.id::text as id from campaign c
       where c.org_id = $1 and c.deleted_at is not null
         and not exists (
           select 1 from deletion d
            where d.org_id = $1 and d.kind = 'campaign'
              and d.subject = c.id::text and d.purged_at is null
         )
     order by c.id`,
    [orgId],
  );
  for (const { id: campaignId } of orphans) {
    await insertCampaignDeletion(db, { orgId, campaignId, requestedBy, grace: "0 hours" });
  }
  return blocked;
}

/**
 * D241 step 4: delete the org's rows, in the order the locks fall and the
 * cascades resolve. ONE short transaction of fixed-literal deletes by `org_id`
 * — every statement below is idempotent, so a re-run after a crash at any point
 * before this step converges (D231): each `where org_id = $1` is its own guard.
 */
export async function deleteOrgRows(db: SqlClient, orgId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query(`delete from provider_key where org_id = $1`, [orgId]);
    await tx.query(
      `delete from team_member where team_id in (select id from team where org_id = $1)`,
      [orgId],
    );
    await tx.query(`delete from team where org_id = $1`, [orgId]);
    await tx.query(`delete from invitation where org_id = $1`, [orgId]);
    await tx.query(`delete from member where org_id = $1`, [orgId]);
    // fixed literal table names, never caller input
    for (const table of LEFTOVER_TABLES) {
      await tx.query(`delete from ${table} where org_id = $1`, [orgId]);
    }
  });
}

/**
 * D241 step 5: free the org's bytes. `s3` empties `org/<orgId>/` in one
 * `deletePrefix` (spanning `campaign/` AND `cache/`); `fs` removes the org's two
 * trees through `storageRoots`, never a bare `projectRoot()`, and only after the
 * `local` refusal. Idempotent (D231): a second call deletes nothing and
 * succeeds, the same crash-safe property a campaign purge relies on.
 */
export async function deleteOrgObjects(orgId: string): Promise<void> {
  refuseLocal(orgId);
  if (objectStore() === "s3") {
    await objectStoreClient().deletePrefix(orgPrefix(orgId));
    return;
  }
  const roots = storageRoots({ orgId, userId: "system", roles: [], teamIds: [] });
  await rm(roots.projectRoot, { recursive: true, force: true });
  await rm(roots.outputRoot, { recursive: true, force: true });
}

/**
 * D241 steps 1–8: the org purge, composing the campaign queue (step 2) with the
 * row and byte frees. A crash at any point leaves the `deletion` row re-claimable
 * once its lease lapses (D231): steps 2 and 4 are idempotent by `org_id`, step 6
 * is an `update ... where id = $1`, and `markPurged`. A re-run after completion
 * therefore answers `"purged"` and changes nothing (D241 step 8).
 *
 * The count in step 3 makes this a real work queue: any campaign row still
 * present (even a tombstoned one whose purge is pending) makes the sweep answer
 * `"retry"` and the cron re-claims this row after its lease — pending purges are
 * normal, never a failure.
 */
export async function purgeOrg(
  db: SqlClient,
  orgId: string,
  deletionRow: Pick<DeletionRow, "id" | "requestedBy">,
): Promise<"purged" | "retry"> {
  refuseLocal(orgId);
  const { rows } = await db.query<{ deleted_at: Date | null }>(
    `select deleted_at from org where id = $1`,
    [orgId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`unknown org "${orgId}"`);
  if (row.deleted_at === null) {
    throw new Error(`org "${orgId}" is not tombstoned; refusing to purge it`);
  }
  if (await queueCampaignPurges(db, orgId, deletionRow.requestedBy)) {
    await recordFailure(db, deletionRow.id, ORG_BLOCKED_MESSAGE);
    return "retry";
  }
  const { rows: left } = await db.query<{ n: number }>(
    `select count(*)::int as n from campaign where org_id = $1`,
    [orgId],
  );
  if (left[0]!.n > 0) return "retry";
  await deleteOrgRows(db, orgId);
  await deleteOrgObjects(orgId);
  await db.query(
    `update org set name = 'Deleted org', slug = id, logo = null, metadata = null where id = $1`,
    [orgId],
  );
  await db.query(
    `update deletion set requested_by = 'erased:' || gen_random_uuid()::text where org_id = $1 and requested_by not like 'erased:%'`,
    [orgId],
  );
  // D241 step 8: mark the row purged, but only once — `markPurged` stamps
  // `purged_at = now()`, so re-running it would change the row and break the
  // "a second run changes nothing" invariant (6f). A re-run after a crash that
  // already reached this step simply skips it; the row is already gone either
  // way, so the sweep answers "purged" and converges.
  const { rows: already } = await db.query<{ purged_at: Date | null }>(
    `select purged_at from deletion where id = $1`,
    [deletionRow.id],
  );
  if (already[0]!.purged_at === null) {
    await markPurged(db, deletionRow.id);
  }
  return "purged";
}
