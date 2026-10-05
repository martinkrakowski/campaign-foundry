import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, describe, expect, test } from "vitest";
import type { SqlClient } from "../../db/sql-client.js";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import {
  deleteCampaignRows,
  hasActiveJob,
  markPurged,
  resolveCampaignForPurge,
} from "../purge-campaign.js";
import { QUEUED_TTL_MS } from "../../ports/job-store.port.js";

/** Plant a campaign row, optionally tombstoned, returning its uuid id. */
async function seedCampaign(
  db: SqlClient,
  orgId: string,
  slug: string,
  opts: { id?: string; tombstoned?: boolean } = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into campaign (id, org_id, slug, deleted_at)
       values (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4)
     returning id`,
    [opts.id ?? null, orgId, slug, opts.tombstoned ? new Date() : null],
  );
  return rows[0]!.id;
}

/** Plant a `job` row directly, bypassing the store, in whatever state a test needs. */
async function seedJob(
  db: SqlClient,
  job: {
    id: string;
    orgId: string;
    campaignId: string;
    status: "queued" | "running" | "completed" | "failed";
    leaseOffsetMs?: number;
  },
): Promise<void> {
  await db.query(
    `insert into job (id, org_id, campaign_id, status, lease_expires_at, created_at)
       values ($1, $2, $3, $4, now() + ($5 || ' milliseconds')::interval, now())`,
    [job.id, job.orgId, job.campaignId, job.status, job.leaseOffsetMs ?? 0],
  );
}

/** Count rows in a slug- or uuid-keyed table for one campaign, by BOTH keys. */
async function countKeyed(
  db: SqlClient,
  table: string,
  orgId: string,
  slug: string,
  campaignId: string,
): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int as n from ${table} where org_id = $1 and campaign_id in ($2, $3)`,
    [orgId, slug, campaignId],
  );
  return rows[0]!.n;
}

/** Plant the five slug/uuid-keyed tables for a campaign: two rows each (slug + uuid). */
async function plantKeyedRows(
  db: SqlClient,
  orgId: string,
  slug: string,
  campaignId: string,
): Promise<void> {
  await db.query(
    `insert into decision (org_id, campaign_id, asset_key, ordinal, verdict, actor, decided_at, run)
       values ($1, $2, 'a', 1, 'approved', 'a', now(), 'r')`,
    [orgId, slug],
  );
  await db.query(
    `insert into decision (org_id, campaign_id, asset_key, ordinal, verdict, actor, decided_at, run)
       values ($1, $2, 'a', 1, 'approved', 'a', now(), 'r')`,
    [orgId, campaignId],
  );
  await db.query(`insert into decision_set (org_id, campaign_id, revision) values ($1, $2, 'r')`, [
    orgId,
    slug,
  ]);
  await db.query(`insert into decision_set (org_id, campaign_id, revision) values ($1, $2, 'r')`, [
    orgId,
    campaignId,
  ]);
  await db.query(
    `insert into report (org_id, campaign_id, body, revision) values ($1, $2, 'b', 'r')`,
    [orgId, slug],
  );
  await db.query(
    `insert into report (org_id, campaign_id, body, revision) values ($1, $2, 'b', 'r')`,
    [orgId, campaignId],
  );
  await db.query(
    `insert into pool (org_id, campaign_id, body, revision) values ($1, $2, 'b', 'r')`,
    [orgId, slug],
  );
  await db.query(
    `insert into pool (org_id, campaign_id, body, revision) values ($1, $2, 'b', 'r')`,
    [orgId, campaignId],
  );
  await db.query(
    `insert into job (id, org_id, campaign_id, status) values ($1, $2, $3, 'completed')`,
    [`job-${slug}`, orgId, slug],
  );
  await db.query(
    `insert into job (id, org_id, campaign_id, status) values ($1, $2, $3, 'completed')`,
    [`job-${campaignId}`, orgId, campaignId],
  );
}

describe("purge-campaign (D232, D246)", () => {
  let db: SqlClient;
  beforeEach(async () => {
    db = await migratedDatabase();
    // `local` is seeded by 0001_org.sql; both `campaign` and `job` reference it.
  });
  afterEach(async () => {
    await db.end();
  });

  describe("hasActiveJob (D232 step 1, dual-key D246)", () => {
    let slug: string;
    let campaignId: string;
    beforeEach(async () => {
      slug = `camp-${randomUUID().slice(0, 8)}`;
      campaignId = await seedCampaign(db, "local", slug);
    });

    test("hasActiveJob is true for a queued job by slug", async () => {
      await seedJob(db, { id: "j-slug", orgId: "local", campaignId: slug, status: "queued" });
      expect(await hasActiveJob(db, "local", slug, campaignId)).toBe(true);
    });

    test("hasActiveJob is true for a running job by the campaigns uuid text", async () => {
      await seedJob(db, {
        id: "j-uuid",
        orgId: "local",
        campaignId,
        status: "running",
        leaseOffsetMs: QUEUED_TTL_MS + 60_000,
      });
      expect(await hasActiveJob(db, "local", slug, campaignId)).toBe(true);
    });

    test("hasActiveJob is false for a completed or failed job", async () => {
      await seedJob(db, { id: "j-done", orgId: "local", campaignId: slug, status: "completed" });
      await seedJob(db, { id: "j-fail", orgId: "local", campaignId: slug, status: "failed" });
      expect(await hasActiveJob(db, "local", slug, campaignId)).toBe(false);
    });

    test("hasActiveJob is false once the lease has lapsed", async () => {
      await seedJob(db, {
        id: "j-lapsed",
        orgId: "local",
        campaignId: slug,
        status: "running",
        leaseOffsetMs: -60_000,
      });
      expect(await hasActiveJob(db, "local", slug, campaignId)).toBe(false);
    });
  });

  describe("resolveCampaignForPurge (uuid-gated subject resolution, resume case)", () => {
    test("resolveCampaignForPurge finds a tombstoned campaign by uuid", async () => {
      const slug = `camp-${randomUUID().slice(0, 8)}`;
      const campaignId = await seedCampaign(db, "local", slug, { tombstoned: true });
      const found = await resolveCampaignForPurge(db, "local", campaignId);
      expect(found).toEqual({ id: campaignId, slug });
    });

    test("resolveCampaignForPurge returns undefined for an unknown uuid", async () => {
      const missing = randomUUID();
      await expect(resolveCampaignForPurge(db, "local", missing)).resolves.toBeUndefined();
    });

    test("resolveCampaignForPurge refuses a live campaign", async () => {
      const slug = `camp-${randomUUID().slice(0, 8)}`;
      const campaignId = await seedCampaign(db, "local", slug, { tombstoned: false });
      await expect(resolveCampaignForPurge(db, "local", campaignId)).rejects.toThrow(
        /not tombstoned/,
      );
    });

    test("resolveCampaignForPurge refuses a subject that is not a uuid", async () => {
      await expect(resolveCampaignForPurge(db, "local", "a-plain-slug")).rejects.toThrow(
        /is not a campaign uuid/,
      );
    });
  });

  describe("deleteCampaignRows (D232 step 3, transaction + dual-key + cascade)", () => {
    test("deleteCampaignRows frees decision, decision_set, report, pool and job by slug and by the campaigns uuid text", async () => {
      const slug = `camp-${randomUUID().slice(0, 8)}`;
      const campaignId = await seedCampaign(db, "local", slug, { tombstoned: true });
      await plantKeyedRows(db, "local", slug, campaignId);

      const before = await Promise.all(
        ["decision", "decision_set", "report", "pool", "job"].map((t) =>
          countKeyed(db, t, "local", slug, campaignId),
        ),
      );
      expect(before).toEqual([2, 2, 2, 2, 2]);

      const result = await deleteCampaignRows(db, "local", campaignId);
      expect(result).toBe("deleted");

      const after = await Promise.all(
        ["decision", "decision_set", "report", "pool", "job"].map((t) =>
          countKeyed(db, t, "local", slug, campaignId),
        ),
      );
      expect(after).toEqual([0, 0, 0, 0, 0]);
    });

    test("deleteCampaignRows frees brief_version and cascades asset draft and last_opened", async () => {
      const slug = `camp-${randomUUID().slice(0, 8)}`;
      const campaignId = await seedCampaign(db, "local", slug, { tombstoned: true });
      await db.query(
        `insert into brief_version (campaign_id, version, body, revision, actor) values ($1, 1, 'b', 'r', 'a')`,
        [campaignId],
      );
      await db.query(
        `insert into asset (org_id, campaign_id, kind, name, size, sha256, content_type)
         values ($1, $2, 'input', 'n', 1, 's', 't')`,
        ["local", campaignId],
      );
      await db.query(
        `insert into draft (campaign_id, user_id, org_id, state) values ($1, 'u', $2, '{}')`,
        [campaignId, "local"],
      );
      await db.query(
        `insert into last_opened (org_id, user_id, campaign_id) values ($1, 'u', $2)`,
        ["local", campaignId],
      );

      const result = await deleteCampaignRows(db, "local", campaignId);
      expect(result).toBe("deleted");

      const { rows: counts } = await db.query<{
        campaign: number;
        brief_version: number;
        asset: number;
        draft: number;
        last_opened: number;
      }>(
        `select
           (select count(*)::int from campaign where id = $1) as campaign,
           (select count(*)::int from brief_version where campaign_id = $1) as brief_version,
           (select count(*)::int from asset where campaign_id = $1) as asset,
           (select count(*)::int from draft where campaign_id = $1) as draft,
           (select count(*)::int from last_opened where campaign_id = $1) as last_opened`,
        [campaignId],
      );
      expect(counts[0]).toEqual({
        campaign: 0,
        brief_version: 0,
        asset: 0,
        draft: 0,
        last_opened: 0,
      });
    });

    test("deleteCampaignRows is idempotent and never touches another campaign", async () => {
      const slugA = `camp-${randomUUID().slice(0, 8)}`;
      const idA = await seedCampaign(db, "local", slugA, { tombstoned: true });
      await plantKeyedRows(db, "local", slugA, idA);
      await db.query(
        `insert into brief_version (campaign_id, version, body, revision, actor) values ($1, 1, 'b', 'r', 'a')`,
        [idA],
      );

      // A second, untouched campaign in the same org — must survive both calls.
      const slugB = `camp-${randomUUID().slice(0, 8)}`;
      const idB = await seedCampaign(db, "local", slugB, { tombstoned: true });

      const first = await deleteCampaignRows(db, "local", idA);
      const second = await deleteCampaignRows(db, "local", idA);
      expect(first).toBe("deleted");
      expect(second).toBe("already-gone");

      const { rows: surviving } = await db.query<{ b: number }>(
        `select count(*)::int as b from campaign where id = $1`,
        [idB],
      );
      expect(surviving[0]!.b).toBe(1);
    });

    test("deleteCampaignRows refuses a live campaign and leaves every row in place", async () => {
      const slug = `camp-${randomUUID().slice(0, 8)}`;
      const campaignId = await seedCampaign(db, "local", slug, { tombstoned: false });
      await plantKeyedRows(db, "local", slug, campaignId);
      const countsBefore = await Promise.all(
        ["decision", "decision_set", "report", "pool", "job"].map((t) =>
          countKeyed(db, t, "local", slug, campaignId),
        ),
      );

      await expect(deleteCampaignRows(db, "local", campaignId)).rejects.toThrow(/not tombstoned/);

      const countsAfter = await Promise.all(
        ["decision", "decision_set", "report", "pool", "job"].map((t) =>
          countKeyed(db, t, "local", slug, campaignId),
        ),
      );
      expect(countsAfter).toEqual(countsBefore);
      const { rows: campaign } = await db.query<{ n: number }>(
        `select count(*)::int as n from campaign where id = $1`,
        [campaignId],
      );
      expect(campaign[0]!.n).toBe(1);
    });

    test("deleteCampaignRows never reaches another orgs brief versions", async () => {
      // A second org (with its own campaign + brief_version), reached only by
      // mistake: the org_id mismatch in the FOR UPDATE select finds no row and
      // returns "already-gone", so the cross-org brief_version is untouched.
      await db.query("insert into org (id, name) values ($1, $2)", ["other-org", "Other"]);
      const otherSlug = `camp-${randomUUID().slice(0, 8)}`;
      const otherId = await seedCampaign(db, "other-org", otherSlug, { tombstoned: true });
      await db.query(
        `insert into brief_version (campaign_id, version, body, revision, actor) values ($1, 1, 'b', 'r', 'a')`,
        [otherId],
      );

      const result = await deleteCampaignRows(db, "local", otherId);
      expect(result).toBe("already-gone");

      const { rows: counted } = await db.query<{ n: number }>(
        `select count(*)::int as n from brief_version where campaign_id = $1`,
        [otherId],
      );
      expect(counted[0]!.n).toBe(1);
    });
  });

  describe("markPurged (D232 step 5)", () => {
    test("markPurged sets purged_at and is idempotent", async () => {
      const subject = randomUUID();
      const { rows } = await db.query<{ id: string }>(
        `insert into deletion (org_id, kind, subject, requested_by, not_before)
           values ('local', 'campaign', $1, 'tester', now())
         returning id`,
        [subject],
      );
      const id = rows[0]!.id;

      await markPurged(db, id);
      const { rows: one } = await db.query<{ purged_at: Date | null }>(
        `select purged_at from deletion where id = $1`,
        [id],
      );
      expect(one[0]!.purged_at).not.toBeNull();

      await markPurged(db, id); // idempotent: no throw
    });
  });
});
