import { randomUUID } from "node:crypto";
import type { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import type { SqlClient } from "../../db/sql-client.js";
import { purgeCampaign } from "../purge-campaign.js";
import { purgeOrg, requestOrgDeletion } from "../purge-org.js";
import { campaignPrefix, cachePrefix, orgPrefix } from "../../object-store/object-keys.js";

const BYTES = new Uint8Array([42]);

export interface CampaignRef {
  readonly id: string;
  readonly slug: string;
}

export interface SeededOrg {
  readonly campaigns: readonly CampaignRef[];
}

export interface OrgDeletionRowRef {
  readonly id: string;
  readonly requestedBy: string;
}

export interface OrgSnapshot {
  readonly org: readonly string[];
  readonly campaign: readonly string[];
  readonly decision: readonly string[];
  readonly decision_set: readonly string[];
  readonly report: readonly string[];
  readonly pool: readonly string[];
  readonly job: readonly string[];
  readonly asset: readonly string[];
  readonly draft: readonly string[];
  readonly last_opened: readonly string[];
  readonly provider_key: readonly string[];
  readonly usage: readonly string[];
  readonly team: readonly string[];
  readonly member: readonly string[];
  readonly invitation: readonly string[];
  readonly deletion: readonly string[];
  readonly brief_version: readonly string[];
  readonly team_member: readonly string[];
}

async function rowsAsJson(
  db: SqlClient,
  sql: string,
  params: readonly unknown[],
): Promise<string[]> {
  const { rows } = await db.query<{ row: string }>(sql, params);
  return rows.map((r) => r.row);
}

/**
 * A full byte-for-byte snapshot of every row one org owns, as JSON text, one
 * entry per table in the exact list below. Used to prove a sweep touches no
 * row that it should not (D231): a re-run after a crash converges (each
 * statement is a delete/update by `org_id`).
 */
export async function snapshot(db: SqlClient, orgId: string): Promise<OrgSnapshot> {
  const q = (sql: string, params: readonly unknown[]) => rowsAsJson(db, sql, params);
  const [org, campaign, decision, decision_set, report, pool, job, asset, draft, last_opened] =
    await Promise.all([
      q(`select to_jsonb(t)::text as row from org t where id = $1 order by 1`, [orgId]),
      q(`select to_jsonb(t)::text as row from campaign t where org_id = $1 order by 1`, [orgId]),
      q(`select to_jsonb(t)::text as row from decision t where org_id = $1 order by 1`, [orgId]),
      q(`select to_jsonb(t)::text as row from decision_set t where org_id = $1 order by 1`, [
        orgId,
      ]),
      q(`select to_jsonb(t)::text as row from report t where org_id = $1 order by 1`, [orgId]),
      q(`select to_jsonb(t)::text as row from pool t where org_id = $1 order by 1`, [orgId]),
      q(`select to_jsonb(t)::text as row from job t where org_id = $1 order by 1`, [orgId]),
      q(`select to_jsonb(t)::text as row from asset t where org_id = $1 order by 1`, [orgId]),
      q(`select to_jsonb(t)::text as row from draft t where org_id = $1 order by 1`, [orgId]),
      q(`select to_jsonb(t)::text as row from last_opened t where org_id = $1 order by 1`, [orgId]),
    ]);
  const [provider_key, usage, team, member, invitation, deletion] = await Promise.all([
    q(`select to_jsonb(t)::text as row from provider_key t where org_id = $1 order by 1`, [orgId]),
    q(`select to_jsonb(t)::text as row from usage t where org_id = $1 order by 1`, [orgId]),
    q(`select to_jsonb(t)::text as row from team t where org_id = $1 order by 1`, [orgId]),
    q(`select to_jsonb(t)::text as row from member t where org_id = $1 order by 1`, [orgId]),
    q(`select to_jsonb(t)::text as row from invitation t where org_id = $1 order by 1`, [orgId]),
    q(`select to_jsonb(t)::text as row from deletion t where org_id = $1 order by 1`, [orgId]),
  ]);
  const [brief_version, team_member] = await Promise.all([
    q(
      `select to_jsonb(t)::text as row from brief_version t
         where campaign_id in (select id from campaign where org_id = $1) order by 1`,
      [orgId],
    ),
    q(
      `select to_jsonb(t)::text as row from team_member t
         where team_id in (select id from team where org_id = $1) order by 1`,
      [orgId],
    ),
  ]);
  return {
    org,
    campaign,
    decision,
    decision_set,
    report,
    pool,
    job,
    asset,
    draft,
    last_opened,
    provider_key,
    usage,
    team,
    member,
    invitation,
    deletion,
    brief_version,
    team_member,
  };
}

/** The object keys under one org's prefix, sorted — the bytes are all one byte. */
export async function objectSnapshot(
  store: InMemoryObjectStore,
  orgId: string,
): Promise<readonly string[]> {
  const listed = await store.list(orgPrefix(orgId));
  return listed.map((o) => o.key).sort();
}

const GHOST_SLUG_SUFFIX = "-ghost";
const GHOST_JOB_ID_SUFFIX = `-ghost`;

/** Seed a complete org, returning its campaign refs. `campaigns` defaults to 2. */
export async function seedOrg(
  db: SqlClient,
  orgId: string,
  store?: InMemoryObjectStore,
  opts: { campaigns?: number } = {},
): Promise<SeededOrg> {
  const count = opts.campaigns ?? 2;
  await db.query(`insert into org (id, name, slug, logo, metadata) values ($1, $2, $1, $3, $4)`, [
    orgId,
    `Name of ${orgId}`,
    `logo-${orgId}`,
    `meta-${orgId}`,
  ]);
  const userIds = [`u-${orgId}-1`, `u-${orgId}-2`];
  for (let i = 0; i < 2; i++) {
    await db.query(
      `insert into "user" (id, name, email, email_verified, image) values ($1, $2, $3, false, null)`,
      [userIds[i], `User ${i + 1}`, `${orgId}-${i + 1}@example.test`],
    );
    await db.query(
      `insert into member (id, org_id, user_id, role, created_at) values ($1, $2, $3, $4, now())`,
      [`m-${orgId}-${i + 1}`, orgId, userIds[i], "member"],
    );
  }
  const teamId = `${orgId}:t`;
  await db.query(
    `insert into team (id, name, "memberCount", org_id, created_at, updated_at)
       values ($1, $2, 0, $3, now(), now())`,
    [teamId, `team-of-${orgId}`, orgId],
  );
  await db.query(
    `insert into team_member (id, team_id, user_id, "membershipKey", created_at)
       values ($1, $2, $3, $4, now())`,
    [`tm-${orgId}-u1`, teamId, userIds[0], `${orgId}:t:u1`],
  );
  await db.query(
    `insert into invitation (id, org_id, email, role, team_id, status, expires_at, created_at, inviter_id)
       values ($1, $2, $3, $4, null, $5, now() + interval '1 day', now(), $6)`,
    [`inv-${orgId}`, orgId, `inv-${orgId}@example.test`, "member", "pending", userIds[0]],
  );
  await db.query(
    `insert into provider_key (org_id, provider, ciphertext, iv, tag, sealed_dek, dek_iv, dek_tag, kek_version, last4, created_by, created_at)
       values ($1, 'gemini', 'ct-${orgId}', 'iv', 'tag', 'sd', 'div', 'dtag', 'v1', '0000', $2, now())`,
    [orgId, userIds[0]],
  );

  const campaigns: CampaignRef[] = [];
  for (let i = 0; i < count; i++) {
    const campaignId = randomUUID();
    const s = `${orgId}-${i === 0 ? "one" : "two"}`;
    await db.query(
      `insert into campaign (id, org_id, slug, deleted_at, deleted_by, team_id)
         values ($1::uuid, $2, $3, null, null, null)`,
      [campaignId, orgId, s],
    );
    await db.query(
      `insert into brief_version (campaign_id, version, body, revision, actor) values ($1::uuid, 1, 'b', 'r', 'actor')`,
      [campaignId],
    );
    await db.query(
      `insert into asset (org_id, campaign_id, kind, name, size, sha256, content_type)
         values ($1, $2::uuid, 'input', 'a', 1, 's', 't')`,
      [orgId, campaignId],
    );
    await db.query(
      `insert into draft (campaign_id, user_id, org_id, state) values ($1::uuid, $2, $3, '{}')`,
      [campaignId, userIds[0], orgId],
    );
    if (i === 0) {
      // `last_opened` is per (org, user): seed it for the first campaign only.
      await db.query(
        `insert into last_opened (org_id, user_id, campaign_id) values ($1, $2, $3::uuid)`,
        [orgId, userIds[0], campaignId],
      );
    }
    campaigns.push({ id: campaignId, slug: s });
  }

  const ghost = `${orgId}${GHOST_SLUG_SUFFIX}`;
  await db.query(
    `insert into decision (org_id, campaign_id, asset_key, ordinal, verdict, actor, decided_at, run)
       values ($1, $2, 'g', 1, 'approved', 'a', now(), 'r')`,
    [orgId, ghost],
  );
  await db.query(`insert into decision_set (org_id, campaign_id, revision) values ($1, $2, 'r')`, [
    orgId,
    ghost,
  ]);
  await db.query(
    `insert into report (org_id, campaign_id, body, revision) values ($1, $2, 'b', 'r')`,
    [orgId, ghost],
  );
  await db.query(
    `insert into pool (org_id, campaign_id, body, revision) values ($1, $2, 'b', 'r')`,
    [orgId, ghost],
  );
  await db.query(
    `insert into job (id, org_id, campaign_id, status) values ($1, $2, $3, 'completed')`,
    [`job-${orgId}${GHOST_JOB_ID_SUFFIX}`, orgId, ghost],
  );

  for (let i = 0; i < 2; i++) {
    await db.query(
      `insert into usage (org_id, provider, model, units, key_owner) values ($1, 'gemini', 'm', 1, 'platform')`,
      [orgId],
    );
  }

  await db.query(
    `insert into deletion (org_id, kind, subject, requested_by, not_before, purged_at)
       values ($1, 'campaign', $2, $3, now(), now())`,
    [orgId, randomUUID(), `op-${orgId}`],
  );

  if (store && campaigns.length > 0) {
    const first = campaigns[0]!;
    await store.put(`${campaignPrefix(orgId, first.id)}inputs/x`, BYTES);
    await store.put(`${campaignPrefix(orgId, first.id)}renders/y`, BYTES);
    await store.put(`${cachePrefix(orgId)}z`, BYTES);
  }

  return { campaigns };
}

/** Plant a campaign row (live by default), returning its id. */
export async function seedCampaign(
  db: SqlClient,
  orgId: string,
  slug: string,
  opts: { id?: string; tombstoned?: boolean } = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into campaign (id, org_id, slug, deleted_at, deleted_by, team_id)
       values (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5, null)
     returning id`,
    [
      opts.id ?? null,
      orgId,
      slug,
      opts.tombstoned ? new Date() : null,
      opts.tombstoned ? "operator" : null,
    ],
  );
  return rows[0]!.id;
}

/** Read back the pending (unpurged) `kind = 'org'` deletion row for an org. */
export async function orgRow(db: SqlClient, orgId: string): Promise<OrgDeletionRowRef> {
  const { rows } = await db.query<{ id: string; requested_by: string }>(
    `select id, requested_by from deletion where org_id = $1 and kind = 'org' and purged_at is null order by not_before limit 1`,
    [orgId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`no pending org deletion row for ${orgId}`);
  return { id: row.id, requestedBy: row.requested_by };
}

/** Drain every due `kind = 'campaign'` deletion row of this org by running purgeCampaign. */
export async function finishCampaignPurges(db: SqlClient, orgId: string): Promise<void> {
  for (;;) {
    // Query campaign rows directly (not via claimDue): a due org deletion row
    // must not steal this helper's claim and starve the campaign purges. Tests
    // are single-threaded, so no lease is needed.
    const { rows } = await db.query<{ id: string; subject: string }>(
      `select id, subject from deletion
         where org_id = $1 and kind = 'campaign' and purged_at is null
           and (claimed_until is null or claimed_until < now())
       order by not_before
       limit 1`,
      [orgId],
    );
    const row = rows[0];
    if (row === undefined) break;
    const result = await purgeCampaign(db, orgId, row);
    if (result === "retry") break;
  }
}

export { BYTES };

/**
 * Drive an org all the way through the purge lifecycle: request its deletion
 * (tombstones the org row and plants the `kind = 'org'` deletion row), answer
 * `"retry"` from `purgeOrg` while the seeded campaigns are still live, drain
 * them with `finishCampaignPurges`, then `purgeOrg` again expecting `"purged"`.
 * The caller sets `OBJECT_STORE=s3` and injects an `InMemoryObjectStore` before
 * calling — this helper only touches the database.
 */
export async function purgeOrgCompletely(db: SqlClient, orgId: string): Promise<void> {
  await requestOrgDeletion(db, { orgId, requestedBy: "operator" });
  const { id, requestedBy } = await orgRow(db, orgId);
  if ((await purgeOrg(db, orgId, { id, requestedBy })) !== "retry") {
    throw new Error(`expected purgeOrg to retry for ${orgId}`);
  }
  await finishCampaignPurges(db, orgId);
  const again = await orgRow(db, orgId);
  if ((await purgeOrg(db, orgId, { id: again.id, requestedBy: again.requestedBy })) !== "purged") {
    throw new Error(`expected purgeOrg to purge ${orgId}`);
  }
}

/** Move an org's `deleted_at` tombstone back into the past by `interval`. */
export async function backdateOrg(db: SqlClient, orgId: string, interval: string): Promise<void> {
  await db.query(`update org set deleted_at = now() - $2::interval where id = $1`, [
    orgId,
    interval,
  ]);
}
