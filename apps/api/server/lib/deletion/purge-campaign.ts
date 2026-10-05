import type { SqlClient, SqlQuery } from "../db/sql-client.js";
import { QUEUED_TTL_MS } from "../ports/job-store.port.js";
import { UUID_PATTERN } from "../object-store/object-keys.js";

function asInterval(ms: number): string {
  return `${ms} milliseconds`;
}

/** D232 step 1: refuse while an active job row exists for either key (D246). */
export async function hasActiveJob(
  db: SqlQuery,
  orgId: string,
  slug: string,
  campaignId: string,
): Promise<boolean> {
  const { rows } = await db.query(
    `select 1 from job where org_id = $1 and campaign_id in ($2, $3)
       and (
         (status = 'running' and lease_expires_at > now())
         or (status = 'queued' and created_at > now() - $4::interval)
       )
     limit 1`,
    [orgId, slug, campaignId, asInterval(QUEUED_TTL_MS)],
  );
  return rows.length > 0;
}

/**
 * The campaign this `deletion` row's `subject` names — gated on `UUID_PATTERN`
 * so a malformed subject never reaches the `::uuid` cast (Postgres `22P02`), the
 * same reason `pg-job-store.ts:252`'s `campaignClaimable` gates its own uuid branch
 * before casting. `undefined` means ONLY "no row with this id in this org" — the
 * resumed case (GAP): an earlier, crashed purge attempt already deleted it. A
 * LIVE (non-tombstoned) row THROWS and must never return `undefined` here —
 * silently returning it for a live campaign would let PT-9g2's orchestrator
 * stamp that campaign's deletion record as purged without ever deleting it.
 *
 * On `undefined`: an earlier attempt has already run steps 1–3 (the campaign row
 * is gone); step 4 is NOT skipped. Under s3 the orchestrator still re-lists
 * `campaignPrefix(org, uuid)` and `deletePrefix`es again (step 4 needs only the
 * uuid, which `subject` already is) before `markPurged`. Under fs there is no
 * step 4 after step 3: the slug is released when step 3 commits (D232, "the slug
 * stays reserved until step 3 commits"), so freeing `<slug>/` trees afterwards
 * could erase a NEW campaign's files that inherited the slug — fs trees are freed
 * in step 2 only.
 */
export async function resolveCampaignForPurge(
  db: SqlQuery,
  orgId: string,
  subject: string,
): Promise<{ id: string; slug: string } | undefined> {
  if (!UUID_PATTERN.test(subject)) {
    throw new Error(`deletion subject "${subject}" is not a campaign uuid`);
  }
  const { rows } = await db.query<{ id: string; slug: string; deleted_at: Date | null }>(
    `select id, slug, deleted_at from campaign where org_id = $1 and id = $2::uuid`,
    [orgId, subject.toLowerCase()],
  );
  const row = rows[0];
  if (!row) return undefined;
  if (row.deleted_at === null) {
    throw new Error(`campaign ${row.id} is not tombstoned; refusing to purge it`);
  }
  return { id: row.id, slug: row.slug };
}

/**
 * D232 step 3: in its own short transaction, the campaign row `for update` FIRST
 * (lock order campaign -> job, PT-9c's own rule, `pg-job-store.ts:121-146` — this
 * transaction is a fourth path that takes the same two resources in the same
 * order, so it does not open the cycle that header warns about, even though it is
 * not this PR's place to edit that file to say so), then the five slug/uuid-keyed
 * tables by D246's dual key — using the LOCKED row's own `slug`/`id`, never a
 * caller-supplied slug; there is no one, this function no longer takes one — then
 * `brief_version` (no cascade), then the `campaign` row itself (cascades `asset`,
 * `draft`, `last_opened`). `"already-gone"` is the resume case (GAP): no row at
 * all for this `(org_id, campaignId)`, which this file's own
 * `resolveCampaignForPurge` already proved can only mean an earlier, crashed
 * attempt finished this same delete. A LIVE (non-tombstoned) row THROWS — with a
 * message distinct from `resolveCampaignForPurge`'s own guard, deliberately, so
 * the manifest's witness test can pin exactly which function refused.
 */
export async function deleteCampaignRows(
  db: SqlClient,
  orgId: string,
  campaignId: string,
): Promise<"deleted" | "already-gone"> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<{ id: string; slug: string; deleted_at: Date | null }>(
      `select id, slug, deleted_at from campaign where org_id = $1 and id = $2::uuid for update`,
      [orgId, campaignId],
    );
    const row = rows[0];
    if (!row) return "already-gone";
    if (row.deleted_at === null) {
      throw new Error(`campaign ${row.id} is not tombstoned; refusing to delete its rows`);
    }
    // A uuid-shaped slug (render-target.ts:88-95 — "a uuid-shaped ref may be nobody's
    // id and somebody's slug"): another campaign in this org may carry `row.slug` as
    // its `id::text`, or `row.id::text` as its slug, in which case the dual-key
    // delete below could not be scoped to this campaign's own rows. The rows' owner
    // cannot be told apart from the data, so refuse rather than guess.
    const { rows: collision } = await tx.query<{ one: number }>(
      `select 1 from campaign where org_id = $1 and id <> $2::uuid and (id::text = $3 or slug = $2::text) limit 1`,
      [orgId, row.id, row.slug],
    );
    if (collision[0]) {
      throw new Error(
        `campaign ${row.id} shares a key with another campaign in its org; refusing to delete its rows`,
      );
    }
    // Fixed literal table names, never caller input: no injection surface.
    for (const table of ["decision", "decision_set", "report", "pool", "job"]) {
      await tx.query(`delete from ${table} where org_id = $1 and campaign_id in ($2, $3)`, [
        orgId,
        row.slug,
        row.id,
      ]);
    }
    await tx.query(`delete from brief_version where campaign_id = $1`, [row.id]);
    await tx.query(`delete from campaign where id = $1`, [row.id]);
    return "deleted";
  });
}

/** D232 step 5. */
export async function markPurged(db: SqlClient, deletionId: string): Promise<void> {
  await db.query(`update deletion set purged_at = now() where id = $1`, [deletionId]);
}
