import type { SqlClient, SqlQuery } from "../db/sql-client.js";
import { LOCAL_TENANT } from "../tenant.js";

/** D241, Q5 (owner, 2026-10-04): usage and the org tombstone are kept this long. */
export const ORG_RETENTION = "13 months";

export interface OrgExpiry {
  /** Orgs eligible when the run began (all of them in a dry run). */
  readonly eligible: readonly string[];
  /** Orgs whose `usage` rows and `org` row were deleted (empty in a dry run). */
  readonly expired: readonly string[];
  /** Eligible orgs whose delete rolled back because a row still references them. */
  readonly failed: readonly string[];
}

/**
 * D241, Q5: the org ids that are tombstoned, fully purged, and older than the
 * 13-month retention. `local` is excluded in SQL (`$2`): deleting it would be a
 * mistake OD15 forbids — this is the only hard delete of an `org` row in PT-9.
 */
export async function listExpiredOrgs(db: SqlQuery): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `select o.id from org o where o.deleted_at is not null
     and o.deleted_at < now() - $1::interval
     and o.id <> $2
     and exists (select 1 from deletion d where d.kind = 'org' and d.org_id = o.id and d.subject = o.id and d.purged_at is not null)
     order by o.id`,
    [ORG_RETENTION, LOCAL_TENANT.orgId],
  );
  return rows.map((r) => r.id);
}

/**
 * D241, Q5: re-check the org's eligibility under its row lock (a race can make it
 * ineligible between the listing and here), then delete its `usage` rows FIRST
 * (no cascade on that FK, 0007) and the `org` row itself — the only hard delete
 * of an `org` row in PT-9. The purge-complete `exists` clause mirrors
 * `listExpiredOrgs` so a direct caller cannot expire an org whose purge is
 * incomplete (which would orphan store objects or silently cascade FK rows).
 * One transaction: a FK violation on the `org` delete rolls it ALL back,
 * including the already-issued `usage` delete, so an org is never
 * half-expired; the caller's `catch` reports it as failed and a later run
 * picks it up again (resumable).
 */
export async function expireOrg(db: SqlClient, orgId: string): Promise<"expired" | "skipped"> {
  const result = await db.transaction(async (tx) => {
    const { rows } = await tx.query(
      `select 1 from org o where o.id = $1 and o.deleted_at is not null and o.deleted_at < now() - $2::interval and o.id <> $3
       and exists (select 1 from deletion d where d.kind = 'org' and d.org_id = o.id and d.subject = o.id and d.purged_at is not null)
       for update`,
      [orgId, ORG_RETENTION, LOCAL_TENANT.orgId],
    );
    if (rows.length === 0) return "skipped" as const;
    await tx.query(`delete from usage where org_id = $1`, [orgId]);
    await tx.query(`delete from org where id = $1`, [orgId]);
    return "expired" as const;
  });
  return result;
}

/**
 * D241, Q5 (owner, 2026-10-04): the 13-month usage-retention sweep for org
 * tombstones. Eligible orgs are those `listExpiredOrgs` returns, narrowed to
 * `--org` when it names one. Without `--apply` the lists are returned and
 * nothing is deleted (dry run, the safe default). With `--apply`, each eligible
 * org is expired inside its own transaction: `usage` rows first, then the `org`
 * row; an org that still has referencing rows rolls back and is reported as
 * failed (no hard delete of an org whose FK web is non-empty), never half-expired.
 */
export async function expireOrgTombstones(
  db: SqlClient,
  options: { readonly apply: boolean; readonly org?: string },
): Promise<OrgExpiry> {
  const eligible = (await listExpiredOrgs(db)).filter(
    (id) => options.org === undefined || id === options.org,
  );
  if (!options.apply) return { eligible, expired: [], failed: [] };
  const expired: string[] = [];
  const failed: string[] = [];
  for (const id of eligible) {
    try {
      if ((await expireOrg(db, id)) === "expired") expired.push(id);
    } catch {
      // The cause may be a referencing row OR any other error; the caller
      // reports a fixed message and leaves the org in place.
      failed.push(id);
    }
  }
  return { eligible, expired, failed };
}
