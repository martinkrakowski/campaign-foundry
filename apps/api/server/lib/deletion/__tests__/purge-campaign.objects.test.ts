import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resetProjectRoot } from "@campaignfoundry/shared";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import type { SqlClient } from "../../db/sql-client.js";
import { resetObjectStoreClient, setObjectStoreClient } from "../../object-store/index.js";
import { campaignPrefix } from "../../object-store/object-keys.js";
import {
  deleteCampaignObjects,
  deleteCampaignObjectsByUuid,
  purgeCampaign,
} from "../purge-campaign.js";

const SAVED_OBJECT_STORE = process.env.OBJECT_STORE;
const SAVED_PROJECT_ROOT = process.env.PROJECT_ROOT;
const SAVED_OUTPUT_DIR = process.env.OUTPUT_DIR;
const ORG = "local";
const BYTES = new Uint8Array([42]);

function restoreEnv(): void {
  if (SAVED_OBJECT_STORE === undefined) delete process.env.OBJECT_STORE;
  else process.env.OBJECT_STORE = SAVED_OBJECT_STORE;
  if (SAVED_PROJECT_ROOT === undefined) delete process.env.PROJECT_ROOT;
  else process.env.PROJECT_ROOT = SAVED_PROJECT_ROOT;
  if (SAVED_OUTPUT_DIR === undefined) delete process.env.OUTPUT_DIR;
  else process.env.OUTPUT_DIR = SAVED_OUTPUT_DIR;
  resetProjectRoot();
}

/** Plant a campaign row with a specific uuid, optionally tombstoned. */
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

/** Plant a `deletion` row pointing at a campaign uuid. */
async function seedDeletion(
  db: SqlClient,
  orgId: string,
  subject: string,
  opts: { claimedUntil?: Date | null } = {},
): Promise<{ id: string; subject: string }> {
  const { rows } = await db.query<{ id: string }>(
    `insert into deletion (org_id, kind, subject, requested_by, not_before, claimed_until)
       values ($1, 'campaign', $2, 'tester', now() - interval '1 minute', $3)
     returning id`,
    [orgId, subject, opts.claimedUntil ?? null],
  );
  return { id: rows[0]!.id, subject };
}

/** Plant the five D246 dual-keyed tables (decision, decision_set, report, pool, job) by uuid text. */
async function plantKeyedRows(db: SqlClient, orgId: string, campaignId: string): Promise<void> {
  await db.query(
    `insert into decision (org_id, campaign_id, asset_key, ordinal, verdict, actor, decided_at, run)
     values ($1, $2, 'a', 1, 'approved', 'actor', now(), 'run')`,
    [orgId, campaignId],
  );
  await db.query(`insert into decision_set (org_id, campaign_id, revision) values ($1, $2, 'r')`, [
    orgId,
    campaignId,
  ]);
  await db.query(
    `insert into report (org_id, campaign_id, body, revision) values ($1, $2, 'b', 'r')`,
    [orgId, campaignId],
  );
  await db.query(
    `insert into pool (org_id, campaign_id, body, revision) values ($1, $2, 'b', 'r')`,
    [orgId, campaignId],
  );
  await db.query(
    `insert into job (id, org_id, campaign_id, status) values ($1, $2, $3, 'completed')`,
    [`job-${randomUUID()}`, orgId, campaignId],
  );
}

/** Plant brief_version, asset (+ optional s3 object), draft, last_opened. */
async function plantCascadeRows(
  db: SqlClient,
  orgId: string,
  campaignId: string,
  store: InMemoryObjectStore | null,
): Promise<void> {
  await db.query(
    `insert into brief_version (campaign_id, version, body, revision, actor) values ($1::uuid, 1, 'b', 'r', 'actor')`,
    [campaignId],
  );
  const assetId = randomUUID();
  await db.query(
    `insert into asset (id, org_id, campaign_id, kind, name, size, sha256, content_type)
     values ($1::uuid, $2, $3::uuid, 'input', 'logo.png', 1, 'sha256hash', 'image/png')`,
    [assetId, orgId, campaignId],
  );
  if (store) {
    await store.put(`${campaignPrefix(orgId, campaignId)}inputs/${assetId}`, BYTES);
  }
  await db.query(
    `insert into draft (campaign_id, user_id, org_id, state) values ($1::uuid, 'u', $2, '{}')`,
    [campaignId, orgId],
  );
  await db.query(
    `insert into last_opened (org_id, user_id, campaign_id) values ($1, 'u', $2::uuid)`,
    [orgId, campaignId],
  );
}

/** Plant every row for a full campaign, returning its id and deletion row. */
async function plantFullCampaign(
  db: SqlClient,
  orgId: string,
  slug: string,
  store: InMemoryObjectStore | null,
): Promise<{ campaignId: string; deletionRow: { id: string; subject: string } }> {
  const campaignId = await seedCampaign(db, orgId, slug, { tombstoned: true });
  const deletionRow = await seedDeletion(db, orgId, campaignId);
  await plantKeyedRows(db, orgId, campaignId);
  await plantCascadeRows(db, orgId, campaignId, store);
  return { campaignId, deletionRow };
}

/** Assert every one of the ten per-campaign tables has zero rows for this campaign. */
async function assertAllTablesCleared(
  db: SqlClient,
  orgId: string,
  campaignId: string,
  slug: string,
): Promise<void> {
  const { rows } = await db.query<{
    campaign: number;
    brief_version: number;
    asset: number;
    draft: number;
    last_opened: number;
    decision: number;
    decision_set: number;
    report: number;
    pool: number;
    job: number;
  }>(
    `select
       (select count(*)::int from campaign where id = $1::uuid) as campaign,
       (select count(*)::int from brief_version where campaign_id = $1::uuid) as brief_version,
       (select count(*)::int from asset where campaign_id = $1::uuid) as asset,
       (select count(*)::int from draft where campaign_id = $1::uuid) as draft,
       (select count(*)::int from last_opened where campaign_id = $1::uuid) as last_opened,
       (select count(*)::int from decision where org_id = $2 and campaign_id in ($3, $1::text)) as decision,
       (select count(*)::int from decision_set where org_id = $2 and campaign_id in ($3, $1::text)) as decision_set,
       (select count(*)::int from report where org_id = $2 and campaign_id in ($3, $1::text)) as report,
       (select count(*)::int from pool where org_id = $2 and campaign_id in ($3, $1::text)) as pool,
       (select count(*)::int from job where org_id = $2 and campaign_id in ($3, $1::text)) as job`,
    [campaignId, orgId, slug],
  );
  expect(rows[0]).toEqual({
    campaign: 0,
    brief_version: 0,
    asset: 0,
    draft: 0,
    last_opened: 0,
    decision: 0,
    decision_set: 0,
    report: 0,
    pool: 0,
    job: 0,
  });
}

describe("purge-campaign objects (PT-9g2)", () => {
  describe("s3 offline", () => {
    let store: InMemoryObjectStore;

    beforeEach(() => {
      process.env.OBJECT_STORE = "s3";
      store = new InMemoryObjectStore();
      setObjectStoreClient(store);
    });
    afterEach(() => {
      resetObjectStoreClient();
      restoreEnv();
    });

    test("deleteCampaignObjectsByUuid under s3 empties every key under campaignPrefix", async () => {
      const campaignId = randomUUID();
      const prefix = campaignPrefix(ORG, campaignId);

      await store.put(`${prefix}inputs/asset-1`, BYTES);
      await store.put(`${prefix}renders/render-1`, BYTES);
      await store.put(`${prefix}packages/pkg-1`, BYTES);

      await deleteCampaignObjectsByUuid(ORG, campaignId);

      expect(await store.list(prefix)).toHaveLength(0);
    });

    test("deleteCampaignObjectsByUuid under s3 leaves a sibling campaign and a sibling org untouched", async () => {
      const campaignIdA = randomUUID();
      const campaignIdB = randomUUID();
      const otherOrg = "other-org";
      const prefixA = campaignPrefix(ORG, campaignIdA);
      const prefixB = campaignPrefix(ORG, campaignIdB);
      const prefixOtherOrg = campaignPrefix(otherOrg, campaignIdA);

      await store.put(`${prefixA}inputs/a`, BYTES);
      await store.put(`${prefixB}inputs/b`, BYTES);
      await store.put(`${prefixOtherOrg}inputs/c`, BYTES);

      await deleteCampaignObjectsByUuid(ORG, campaignIdA);

      expect(await store.list(prefixA)).toHaveLength(0);
      expect(await store.list(prefixB)).toHaveLength(1);
      expect(await store.list(prefixOtherOrg)).toHaveLength(1);
    });

    test("deleteCampaignObjectsByUuid under s3 is harmless on a second call", async () => {
      const campaignId = randomUUID();
      const prefix = campaignPrefix(ORG, campaignId);

      await store.put(`${prefix}inputs/a`, BYTES);

      await deleteCampaignObjectsByUuid(ORG, campaignId);
      await deleteCampaignObjectsByUuid(ORG, campaignId);

      expect(await store.list(prefix)).toHaveLength(0);
    });

    test("deleteCampaignObjects under s3 empties the same three keys as deleteCampaignObjectsByUuid", async () => {
      const campaignId = randomUUID();
      const slug = "winter-sale";
      const prefix = campaignPrefix(ORG, campaignId);

      await store.put(`${prefix}inputs/a`, BYTES);
      await store.put(`${prefix}renders/r`, BYTES);
      await store.put(`${prefix}packages/p`, BYTES);

      await deleteCampaignObjects(ORG, campaignId, slug);

      expect(await store.list(prefix)).toHaveLength(0);
    });
  });

  describe("fs offline", () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "cf-purge-fs-"));
      process.env.OUTPUT_DIR = dir;
      process.env.PROJECT_ROOT = dir;
      process.env.OBJECT_STORE = "fs";
      resetProjectRoot();
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
      restoreEnv();
    });

    test("deleteCampaignObjects under fs removes inputs renders and packages", async () => {
      const campaignId = randomUUID();
      const slug = "winter-sale";

      mkdirSync(join(dir, "assets", "inputs", slug), { recursive: true });
      writeFileSync(join(dir, "assets", "inputs", slug, "f.txt"), "data");
      mkdirSync(join(dir, slug), { recursive: true });
      writeFileSync(join(dir, slug, "f.txt"), "data");
      mkdirSync(join(dir, "packages", slug), { recursive: true });
      writeFileSync(join(dir, "packages", slug, "f.txt"), "data");

      await deleteCampaignObjects(ORG, campaignId, slug);

      expect(() => statSync(join(dir, "assets", "inputs", slug))).toThrow("ENOENT");
      expect(() => statSync(join(dir, slug))).toThrow("ENOENT");
      expect(() => statSync(join(dir, "packages", slug))).toThrow("ENOENT");
    });

    test("deleteCampaignObjects under fs leaves a sibling campaign and package untouched", async () => {
      const campaignId = randomUUID();
      const slug = "winter-sale";
      const siblingSlug = "summer-sale";

      mkdirSync(join(dir, "assets", "inputs", slug), { recursive: true });
      writeFileSync(join(dir, "assets", "inputs", slug, "f.txt"), "data");
      mkdirSync(join(dir, slug), { recursive: true });
      writeFileSync(join(dir, slug, "f.txt"), "data");
      mkdirSync(join(dir, "packages", slug), { recursive: true });
      writeFileSync(join(dir, "packages", slug, "f.txt"), "data");

      mkdirSync(join(dir, "assets", "inputs", siblingSlug), { recursive: true });
      writeFileSync(join(dir, "assets", "inputs", siblingSlug, "f.txt"), "data");
      mkdirSync(join(dir, "packages", siblingSlug), { recursive: true });
      writeFileSync(join(dir, "packages", siblingSlug, "f.txt"), "data");

      await deleteCampaignObjects(ORG, campaignId, slug);

      expect(() => statSync(join(dir, "assets", "inputs", slug))).toThrow("ENOENT");
      expect(() => statSync(join(dir, slug))).toThrow("ENOENT");
      expect(() => statSync(join(dir, "packages", slug))).toThrow("ENOENT");
      expect(() => statSync(join(dir, "assets", "inputs", siblingSlug))).not.toThrow();
      expect(() => statSync(join(dir, "packages", siblingSlug))).not.toThrow();
    });

    test("deleteCampaignObjects under fs is harmless when nothing was ever written", async () => {
      const campaignId = randomUUID();
      const slug = "never-written";

      await expect(deleteCampaignObjects(ORG, campaignId, slug)).resolves.toBeUndefined();
    });

    test("deleteCampaignObjectsByUuid under fs touches nothing", async () => {
      const campaignIdA = randomUUID();
      const slug = "shared-slug";

      mkdirSync(join(dir, "assets", "inputs", slug), { recursive: true });
      writeFileSync(join(dir, "assets", "inputs", slug, "a.txt"), "data-a");
      mkdirSync(join(dir, slug), { recursive: true });
      writeFileSync(join(dir, slug, "a.txt"), "data-a");
      mkdirSync(join(dir, "packages", slug), { recursive: true });
      writeFileSync(join(dir, "packages", slug, "a.txt"), "data-a");

      await deleteCampaignObjects(ORG, campaignIdA, slug);
      expect(() => statSync(join(dir, "assets", "inputs", slug))).toThrow("ENOENT");
      expect(() => statSync(join(dir, slug))).toThrow("ENOENT");
      expect(() => statSync(join(dir, "packages", slug))).toThrow("ENOENT");

      mkdirSync(join(dir, "assets", "inputs", slug), { recursive: true });
      writeFileSync(join(dir, "assets", "inputs", slug, "b.txt"), "data-b");
      mkdirSync(join(dir, slug), { recursive: true });
      writeFileSync(join(dir, slug, "b.txt"), "data-b");
      mkdirSync(join(dir, "packages", slug), { recursive: true });
      writeFileSync(join(dir, "packages", slug, "b.txt"), "data-b");

      await deleteCampaignObjectsByUuid(ORG, campaignIdA);

      expect(() => statSync(join(dir, "assets", "inputs", slug, "b.txt"))).not.toThrow();
      expect(() => statSync(join(dir, slug, "b.txt"))).not.toThrow();
      expect(() => statSync(join(dir, "packages", slug, "b.txt"))).not.toThrow();
    });

    test("deleteCampaignObjects under fs is confined to the orgs own orgs directory", async () => {
      const orgId = "test-org";
      const campaignId = randomUUID();
      const slug = "winter-sale";

      mkdirSync(join(dir, slug), { recursive: true });
      writeFileSync(join(dir, slug, "f.txt"), "data");

      await deleteCampaignObjects(orgId, campaignId, slug);

      expect(() => statSync(join(dir, slug, "f.txt"))).not.toThrow();
    });

    test("deleteCampaignObjects under fs refuses a reserved slug: packages", async () => {
      const campaignId = randomUUID();
      const slug = "packages";

      mkdirSync(join(dir, "packages", "other"), { recursive: true });
      writeFileSync(join(dir, "packages", "other", "x"), "data");

      await expect(deleteCampaignObjects(ORG, campaignId, slug)).rejects.toThrow(
        /shared storage area/,
      );

      expect(() => statSync(join(dir, "packages", "other", "x"))).not.toThrow();
    });

    test("deleteCampaignObjects under fs refuses a reserved slug: orgs", async () => {
      const campaignId = randomUUID();
      const slug = "orgs";

      mkdirSync(join(dir, "orgs", "other-org"), { recursive: true });
      writeFileSync(join(dir, "orgs", "other-org", "x"), "data");

      await expect(deleteCampaignObjects(ORG, campaignId, slug)).rejects.toThrow(
        /shared storage area/,
      );

      expect(() => statSync(join(dir, "orgs", "other-org", "x"))).not.toThrow();
    });

    test("deleteCampaignObjects under fs refuses a reserved slug: reports", async () => {
      const campaignId = randomUUID();
      const slug = "reports";

      await expect(deleteCampaignObjects(ORG, campaignId, slug)).rejects.toThrow(
        /shared storage area/,
      );
    });
  });

  describe("purgeCampaign under s3", () => {
    let db: SqlClient;
    let store: InMemoryObjectStore;

    beforeEach(async () => {
      process.env.OBJECT_STORE = "s3";
      db = await migratedDatabase();
      store = new InMemoryObjectStore();
      setObjectStoreClient(store);
    });
    afterEach(async () => {
      resetObjectStoreClient();
      restoreEnv();
      await db.end();
    });

    test("purgeCampaign frees all ten tables and the object prefix under s3", async () => {
      const slug = `camp-${randomUUID().slice(0, 8)}`;
      const { campaignId, deletionRow } = await plantFullCampaign(db, ORG, slug, store);

      const result = await purgeCampaign(db, ORG, deletionRow);
      expect(result).toBe("purged");

      await assertAllTablesCleared(db, ORG, campaignId, slug);
      expect(await store.list(campaignPrefix(ORG, campaignId))).toHaveLength(0);
    });

    test("purgeCampaign retries on an active job and touches nothing", async () => {
      const slug = `camp-${randomUUID().slice(0, 8)}`;
      const campaignId = await seedCampaign(db, ORG, slug, { tombstoned: true });
      const leaseUntil = new Date(Date.now() + 600_000);
      const deletionRow = await seedDeletion(db, ORG, campaignId, { claimedUntil: leaseUntil });

      const prefix = campaignPrefix(ORG, campaignId);
      await store.put(`${prefix}inputs/asset`, BYTES);

      await db.query(
        `insert into job (id, org_id, campaign_id, status, created_at)
         values ($1, $2, $3, 'queued', now())`,
        ["job-active", ORG, slug],
      );

      const result = await purgeCampaign(db, ORG, deletionRow);
      expect(result).toBe("retry");

      const { rows } = await db.query<{ last_error: string | null; claimed_until: Date | null }>(
        `select last_error, claimed_until from deletion where id = $1`,
        [deletionRow.id],
      );
      expect(rows[0]!.last_error).toBe("an active job exists for this campaign");
      expect(rows[0]!.claimed_until).not.toBeNull();

      const { rows: campaignCount } = await db.query<{ n: number }>(
        `select count(*)::int as n from campaign where id = $1::uuid`,
        [campaignId],
      );
      expect(campaignCount[0]!.n).toBe(1);

      const { rows: jobCount } = await db.query<{ n: number }>(
        `select count(*)::int as n from job where org_id = $1 and campaign_id in ($2, $3)`,
        [ORG, slug, campaignId],
      );
      expect(jobCount[0]!.n).toBe(1);

      expect(await store.list(prefix)).toHaveLength(1);
    });

    test("purgeCampaign is idempotent on a second call for an already purged row", async () => {
      const slug = `camp-${randomUUID().slice(0, 8)}`;
      const { campaignId, deletionRow } = await plantFullCampaign(db, ORG, slug, store);
      // Plant a second campaign that must survive the idempotent rerun.
      const otherSlug = `camp-${randomUUID().slice(0, 8)}`;
      await seedCampaign(db, ORG, otherSlug, { tombstoned: true });

      const first = await purgeCampaign(db, ORG, deletionRow);
      expect(first).toBe("purged");

      const second = await purgeCampaign(db, ORG, deletionRow);
      expect(second).toBe("purged");

      const { rows: ownCount } = await db.query<{ n: number }>(
        `select count(*)::int as n from campaign where id = $1::uuid`,
        [campaignId],
      );
      expect(ownCount[0]!.n).toBe(0);
      const { rows } = await db.query<{ n: number }>(
        `select count(*)::int as n from campaign where slug = $1`,
        [otherSlug],
      );
      expect(rows[0]!.n).toBe(1);
    });

    test("purgeCampaign resume frees a late object before markPurged", async () => {
      const slug = `camp-${randomUUID().slice(0, 8)}`;
      const campaignId = await seedCampaign(db, ORG, slug, { tombstoned: true, id: randomUUID() });
      // An upper-case subject: `resolveCampaignForPurge` matches it case-insensitively, so only
      // the resume branch's own `toLowerCase` keeps the s3 prefix pointing at the real keys.
      const deletionRow = await seedDeletion(db, ORG, campaignId.toUpperCase());

      const prefix = campaignPrefix(ORG, campaignId);
      await store.put(`${prefix}inputs/original`, BYTES);

      // Simulate step 2 having already run (objects freed) in a crashed attempt.
      await store.deletePrefix(prefix);
      // Simulate step 3 having already committed (rows freed).
      await db.query(`delete from campaign where id = $1::uuid`, [campaignId]);

      // Plant a LATE object that landed in the gap between the crashed step 2 and the crash.
      await store.put(`${prefix}inputs/late`, BYTES);

      const result = await purgeCampaign(db, ORG, deletionRow);
      expect(result).toBe("purged");

      // The late object was freed and markPurged was called.
      expect(await store.list(prefix)).toHaveLength(0);
      const { rows } = await db.query<{ purged_at: Date | null }>(
        `select purged_at from deletion where id = $1`,
        [deletionRow.id],
      );
      expect(rows[0]!.purged_at).not.toBeNull();
    });

    test("purgeCampaign never marks a key sharing campaign as purged", async () => {
      // B is live; A is tombstoned with A.slug = B.id (uuid-shaped slug collision).
      const bId = await seedCampaign(db, ORG, `camp-${randomUUID().slice(0, 8)}`, {
        tombstoned: false,
      });
      const aId = await seedCampaign(db, ORG, bId, { tombstoned: true });
      const deletionRow = await seedDeletion(db, ORG, aId);

      // Plant A's objects so the test can prove step 2 never ran.
      const prefix = campaignPrefix(ORG, aId);
      await store.put(`${prefix}inputs/asset`, BYTES);

      await expect(purgeCampaign(db, ORG, deletionRow)).rejects.toThrow(/shares a key/);

      const { rows } = await db.query<{ purged_at: Date | null }>(
        `select purged_at from deletion where id = $1`,
        [deletionRow.id],
      );
      expect(rows[0]!.purged_at).toBeNull();

      const { rows: bothCount } = await db.query<{ n: number }>(
        `select count(*)::int as n from campaign where id = $1::uuid or id = $2::uuid`,
        [aId, bId],
      );
      expect(bothCount[0]!.n).toBe(2);

      // Step 2 never ran: A's objects are still present.
      expect(await store.list(prefix)).toHaveLength(1);
    });
  });

  describe("purgeCampaign under fs", () => {
    let db: SqlClient;
    let dir: string;

    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), "cf-purge-fs-"));
      process.env.OUTPUT_DIR = dir;
      process.env.PROJECT_ROOT = dir;
      process.env.OBJECT_STORE = "fs";
      resetProjectRoot();
      db = await migratedDatabase();
    });
    afterEach(async () => {
      rmSync(dir, { recursive: true, force: true });
      restoreEnv();
      await db.end();
    });

    test("purgeCampaign frees all ten tables and the fs trees under fs", async () => {
      const slug = `camp-${randomUUID().slice(0, 8)}`;
      const { campaignId, deletionRow } = await plantFullCampaign(db, ORG, slug, null);

      mkdirSync(join(dir, "assets", "inputs", slug), { recursive: true });
      writeFileSync(join(dir, "assets", "inputs", slug, "f.txt"), "data");
      mkdirSync(join(dir, slug), { recursive: true });
      writeFileSync(join(dir, slug, "f.txt"), "data");
      mkdirSync(join(dir, "packages", slug), { recursive: true });
      writeFileSync(join(dir, "packages", slug, "f.txt"), "data");

      const result = await purgeCampaign(db, ORG, deletionRow);
      expect(result).toBe("purged");

      await assertAllTablesCleared(db, ORG, campaignId, slug);
      expect(() => statSync(join(dir, "assets", "inputs", slug))).toThrow("ENOENT");
      expect(() => statSync(join(dir, slug))).toThrow("ENOENT");
      expect(() => statSync(join(dir, "packages", slug))).toThrow("ENOENT");
    });

    // D232/D231 defect (Qodo on PR #693): under fs the step-2 rm is keyed on the
    // slug, which can be re-inherited by a new campaign once the row is gone. The
    // seam below deletes X's row between sharesCampaignKey and step 2, so a fresh
    // campaign Y reusing the slug "spring" is live with files in step 2's trees.
    test("fs step 2 skips the trees when the campaign row is already gone", async () => {
      const xId = await seedCampaign(db, ORG, "spring", { tombstoned: true });
      const deletionRow = await seedDeletion(db, ORG, xId);

      // Wrap db.query (NOT transaction) so the seam only fires on the bare
      // sharesCampaignKey call purgeCampaign makes before step 2. The transactional
      // selects inside deleteCampaignRows run through tx.query and bypass it.
      const seamDb: SqlClient = {
        ...db,
        query: async <R>(text: string, params?: readonly unknown[]) => {
          const result = await db.query<R>(text, params);
          if (/id <> \$2::uuid/.test(text)) {
            await db.query(`delete from campaign where id = $1::uuid`, [xId]);
            await db.query(`insert into campaign (org_id, slug) values ($1, $2)`, [ORG, "spring"]);
            mkdirSync(join(dir, "assets", "inputs", "spring"), { recursive: true });
            writeFileSync(join(dir, "assets", "inputs", "spring", "y.txt"), "data");
            mkdirSync(join(dir, "spring"), { recursive: true });
            writeFileSync(join(dir, "spring", "y.png"), "data");
            mkdirSync(join(dir, "packages", "spring"), { recursive: true });
            writeFileSync(join(dir, "packages", "spring", "y.zip"), "data");
          }
          return result;
        },
      };

      const result = await purgeCampaign(seamDb, ORG, deletionRow);
      expect(result).toBe("purged");

      expect(() => statSync(join(dir, "assets", "inputs", "spring", "y.txt"))).not.toThrow();
      expect(() => statSync(join(dir, "spring", "y.png"))).not.toThrow();
      expect(() => statSync(join(dir, "packages", "spring", "y.zip"))).not.toThrow();
    });

    // Regression for the fix: the locked row still exists, so step 2 frees the
    // trees named by that row's slug and step 3 deletes the rows.
    test("purgeCampaign under fs frees the trees named by the locked row", async () => {
      const slug = "spring";
      const campaignId = await seedCampaign(db, ORG, slug, { tombstoned: true });
      const deletionRow = await seedDeletion(db, ORG, campaignId);

      mkdirSync(join(dir, "assets", "inputs", slug), { recursive: true });
      writeFileSync(join(dir, "assets", "inputs", slug, "x.txt"), "data");
      mkdirSync(join(dir, slug), { recursive: true });
      writeFileSync(join(dir, slug, "x.txt"), "data");
      mkdirSync(join(dir, "packages", slug), { recursive: true });
      writeFileSync(join(dir, "packages", slug, "x.txt"), "data");

      const result = await purgeCampaign(db, ORG, deletionRow);
      expect(result).toBe("purged");

      expect(() => statSync(join(dir, "assets", "inputs", slug))).toThrow("ENOENT");
      expect(() => statSync(join(dir, slug))).toThrow("ENOENT");
      expect(() => statSync(join(dir, "packages", slug))).toThrow("ENOENT");

      const { rows } = await db.query<{ purged_at: Date | null }>(
        `select purged_at from deletion where id = $1`,
        [deletionRow.id],
      );
      expect(rows[0]!.purged_at).not.toBeNull();
    });
  });
});
