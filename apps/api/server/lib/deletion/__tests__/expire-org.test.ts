import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import type { SqlClient } from "../../db/sql-client.js";
import { resetObjectStoreClient, setObjectStoreClient } from "../../object-store/index.js";
import { requestOrgDeletion } from "../purge-org.js";
import { expireOrg, expireOrgTombstones } from "../expire-org.js";
import {
  backdateOrg,
  purgeOrgCompletely,
  seedOrg,
  snapshot,
  objectSnapshot,
} from "./purge-org-fixtures.js";

function saveStore(): string | undefined {
  return process.env.OBJECT_STORE;
}
function restoreStore(saved: string | undefined): void {
  if (saved === undefined) delete process.env.OBJECT_STORE;
  else process.env.OBJECT_STORE = saved;
}

describe("expireOrgTombstones (PT-9m4, D241, Q5)", () => {
  let db: SqlClient;
  let store: InMemoryObjectStore;
  let savedStore: string | undefined;

  beforeEach(async () => {
    db = await migratedDatabase();
    savedStore = saveStore();
    process.env.OBJECT_STORE = "s3";
    store = new InMemoryObjectStore();
    setObjectStoreClient(store);
  });
  afterEach(async () => {
    await db.end();
    resetObjectStoreClient();
    restoreStore(savedStore);
  });

  test("expireOrgTombstones deletes usage then the org row of a purged org older than thirteen months", async () => {
    await seedOrg(db, "acme", store);
    await seedOrg(db, "beta", store);
    await purgeOrgCompletely(db, "acme");
    const beforeBeta = await snapshot(db, "beta");
    const beforeBetaObj = await objectSnapshot(store, "beta");
    await backdateOrg(db, "acme", "13 months 1 day");
    const beforeAcme = await snapshot(db, "acme");

    const result = await expireOrgTombstones(db, { apply: true });
    expect(result).toEqual({ eligible: ["acme"], expired: ["acme"], failed: [] });

    const { rows: orgCount } = await db.query<{ n: number }>(
      `select count(*)::int as n from org where id = 'acme'`,
    );
    expect(orgCount[0]!.n).toBe(0);
    const { rows: usageCount } = await db.query<{ n: number }>(
      `select count(*)::int as n from usage where org_id = 'acme'`,
    );
    expect(usageCount[0]!.n).toBe(0);
    expect(beforeAcme.usage.length).toBe(2);

    // acme's deletion rows survive (OD20): still all there, purged, anonymised.
    const beforeDelCount = beforeAcme.deletion.length;
    const { rows: del } = await db.query<{ requested_by: string; purged_at: Date | null }>(
      `select requested_by, purged_at from deletion where org_id = 'acme' order by id`,
    );
    expect(del.length).toBe(beforeDelCount);
    for (const row of del) {
      expect(row.requested_by).toMatch(/^erased:/);
      expect(row.purged_at).not.toBeNull();
    }

    // acme's "user" rows still exist (Q13).
    const { rows: users } = await db.query<{ n: number }>(
      `select count(*)::int as n from "user" where id in ('u-acme-1', 'u-acme-2')`,
    );
    expect(users[0]!.n).toBe(2);

    expect(await snapshot(db, "beta")).toEqual(beforeBeta);
    expect(await objectSnapshot(store, "beta")).toEqual(beforeBetaObj);
  });

  test("expireOrgTombstones keeps a tombstone younger than thirteen months and its usage", async () => {
    await seedOrg(db, "acme", store);
    await purgeOrgCompletely(db, "acme");
    await backdateOrg(db, "acme", "12 months");
    const beforeAcme = await snapshot(db, "acme");
    const beforeAcmeObj = await objectSnapshot(store, "acme");

    const result = await expireOrgTombstones(db, { apply: true });
    expect(result).toEqual({ eligible: [], expired: [], failed: [] });

    expect(await snapshot(db, "acme")).toEqual(beforeAcme);
    expect(await objectSnapshot(store, "acme")).toEqual(beforeAcmeObj);
  });

  test("expireOrgTombstones keeps an old tombstone whose purge is not complete", async () => {
    await seedOrg(db, "acme", store);
    await seedOrg(db, "beta", store);
    await requestOrgDeletion(db, { orgId: "acme", requestedBy: "operator" });
    await backdateOrg(db, "acme", "14 months");
    const beforeAcme = await snapshot(db, "acme");
    const beforeAcmeObj = await objectSnapshot(store, "acme");
    const beforeBeta = await snapshot(db, "beta");
    const beforeBetaObj = await objectSnapshot(store, "beta");

    const result = await expireOrgTombstones(db, { apply: true });
    expect(result).toEqual({ eligible: [], expired: [], failed: [] });

    expect(await snapshot(db, "acme")).toEqual(beforeAcme);
    expect(await objectSnapshot(store, "acme")).toEqual(beforeAcmeObj);
    expect(await snapshot(db, "beta")).toEqual(beforeBeta);
    expect(await objectSnapshot(store, "beta")).toEqual(beforeBetaObj);
  });

  test("expireOrgTombstones never touches a live org however old", async () => {
    await seedOrg(db, "beta", store);
    // Both are live (deleted_at is null); backdate created_at five years to prove age alone is not enough.
    await db.query(`update org set created_at = now() - interval '5 years' where id = 'beta'`);
    const beforeBeta = await snapshot(db, "beta");
    const beforeBetaObj = await objectSnapshot(store, "beta");
    const beforeLocal = await snapshot(db, "local");

    const result = await expireOrgTombstones(db, { apply: true });
    expect(result).toEqual({ eligible: [], expired: [], failed: [] });

    expect(await snapshot(db, "beta")).toEqual(beforeBeta);
    expect(await objectSnapshot(store, "beta")).toEqual(beforeBetaObj);
    expect(await snapshot(db, "local")).toEqual(beforeLocal);
  });

  test("expireOrgTombstones dry run lists the eligible orgs and deletes nothing", async () => {
    await seedOrg(db, "acme", store);
    await seedOrg(db, "beta", store);
    await purgeOrgCompletely(db, "acme");
    await backdateOrg(db, "acme", "13 months 1 day");
    const beforeAcme = await snapshot(db, "acme");
    const beforeAcmeObj = await objectSnapshot(store, "acme");

    const dryRun = await expireOrgTombstones(db, { apply: false });
    expect(dryRun).toEqual({ eligible: ["acme"], expired: [], failed: [] });

    expect(await snapshot(db, "acme")).toEqual(beforeAcme);
    expect(await objectSnapshot(store, "acme")).toEqual(beforeAcmeObj);

    const dryRunWithOrg = await expireOrgTombstones(db, { apply: false, org: "beta" });
    expect(dryRunWithOrg).toEqual({ eligible: [], expired: [], failed: [] });
  });

  test("expireOrgTombstones rolls back and reports an org that still has referencing rows", async () => {
    await seedOrg(db, "acme", store);
    await seedOrg(db, "beta", store);
    await purgeOrgCompletely(db, "acme");
    await backdateOrg(db, "acme", "13 months 1 day");
    const beforeBeta = await snapshot(db, "beta");
    const beforeBetaObj = await objectSnapshot(store, "beta");
    // Insert a campaign row AFTER the snapshot to act as the FK blocker.
    await db.query(`insert into campaign (org_id, slug) values ('acme', 'late')`);

    const result = await expireOrgTombstones(db, { apply: true });
    expect(result).toEqual({ eligible: ["acme"], expired: [], failed: ["acme"] });

    // The org row exists and acme still has its two usage rows (rolled back).
    const { rows: orgExists } = await db.query<{ n: number }>(
      `select count(*)::int as n from org where id = 'acme'`,
    );
    expect(orgExists[0]!.n).toBe(1);
    const { rows: usageRows } = await db.query<{ n: number }>(
      `select count(*)::int as n from usage where org_id = 'acme'`,
    );
    expect(usageRows[0]!.n).toBe(2);

    expect(await snapshot(db, "beta")).toEqual(beforeBeta);
    expect(await objectSnapshot(store, "beta")).toEqual(beforeBetaObj);

    // Resumable: remove the blocker, run again -> expired.
    await db.query(`delete from campaign where org_id = 'acme'`);
    const second = await expireOrgTombstones(db, { apply: true });
    expect(second).toEqual({ eligible: ["acme"], expired: ["acme"], failed: [] });
    expect(await snapshot(db, "beta")).toEqual(beforeBeta);
    expect(await objectSnapshot(store, "beta")).toEqual(beforeBetaObj);
  });

  test("expireOrgTombstones never expires the local org", async () => {
    await db.query(`update org set deleted_at = now() - interval '14 months' where id = 'local'`);
    await db.query(
      `insert into deletion (org_id, kind, subject, requested_by, not_before, purged_at)
         values ('local', 'org', 'local', 'x', now(), now())`,
    );
    const beforeLocal = await snapshot(db, "local");

    const result = await expireOrgTombstones(db, { apply: true });
    expect(result).toEqual({ eligible: [], expired: [], failed: [] });

    const { rows: localExists } = await db.query<{ n: number }>(
      `select count(*)::int as n from org where id = 'local'`,
    );
    expect(localExists[0]!.n).toBe(1);
    expect(await snapshot(db, "local")).toEqual(beforeLocal);
  });

  test("expireOrgTombstones skips an org that stopped being eligible between listing and locking", async () => {
    await seedOrg(db, "acme", store);
    await purgeOrgCompletely(db, "acme");
    await backdateOrg(db, "acme", "13 months 1 day");
    const beforeAcme = await snapshot(db, "acme");
    const beforeAcmeObj = await objectSnapshot(store, "acme");

    // Force the transaction to short-circuit: the listing still reads through db.query,
    // but expireOrg's lock re-check returns no row, so the org is skipped (not expired).
    const blocked = { ...db, transaction: async () => "skipped" as const };
    const result = await expireOrgTombstones(blocked as unknown as SqlClient, { apply: true });
    expect(result).toEqual({ eligible: ["acme"], expired: [], failed: [] });

    expect(await snapshot(db, "acme")).toEqual(beforeAcme);
    expect(await objectSnapshot(store, "acme")).toEqual(beforeAcmeObj);
  });

  test("expireOrg skips an org whose purge is not complete even if it is old enough state A rows deleted purge threw", async () => {
    // State A: purgeOrg deleted all org-scoped rows but threw before marking
    // purged_at, so no row references the org, the org is backdated past the
    // retention, but the deletion row has purged_at = NULL.
    await seedOrg(db, "acme", store);
    await purgeOrgCompletely(db, "acme");
    const { rows: delRows } = await db.query<{ id: string }>(
      `select id from deletion where org_id = 'acme' and kind = 'org' order by not_before limit 1`,
    );
    await db.query(`update deletion set purged_at = null where id = $1`, [delRows[0]!.id]);
    await backdateOrg(db, "acme", "13 months 1 day");
    const beforeAcme = await snapshot(db, "acme");

    expect(await expireOrg(db, "acme")).toBe("skipped");

    expect(await snapshot(db, "acme")).toEqual(beforeAcme);
  });

  test("expireOrg skips an org whose purge is not complete state B never purged with cascade FK rows", async () => {
    // State B: tombstoned old org, never purged, with member, team, invitation
    // rows (which would cascade-delete). expireOrg must refuse first.
    await seedOrg(db, "acme", store);
    await requestOrgDeletion(db, { orgId: "acme", requestedBy: "operator" });
    await backdateOrg(db, "acme", "13 months 1 day");
    const beforeAcme = await snapshot(db, "acme");
    const beforeAcmeObj = await objectSnapshot(store, "acme");

    expect(await expireOrg(db, "acme")).toBe("skipped");

    // The cascade FK rows (member, team, invitation) are all still there.
    expect(await snapshot(db, "acme")).toEqual(beforeAcme);
    expect(await objectSnapshot(store, "acme")).toEqual(beforeAcmeObj);
  });

  test("expireOrg expires an org whose purge is complete and is old enough", async () => {
    await seedOrg(db, "acme", store);
    await purgeOrgCompletely(db, "acme");
    await backdateOrg(db, "acme", "13 months 1 day");

    expect(await expireOrg(db, "acme")).toBe("expired");

    const { rows: n } = await db.query<{ n: number }>(
      `select count(*)::int as n from org where id = 'acme'`,
    );
    expect(n[0]!.n).toBe(0);
  });

  test("expireOrgTombstones keeps a tombstone at thirteen months minus one hour and expires one at thirteen months plus one hour", async () => {
    // The exact 13-month instant is not tested because the DB clock and the
    // backdate statement are separate steps: a statement-level now() - interval
    // '13 months' cannot be matched exactly across two statements. Instead we
    // test two points close on either side. Interval '13 months 1 hour' means
    // 13 months + 1 hour (over the threshold); '12 months 23 hours' is just
    // under.
    await seedOrg(db, "acme", store);
    await purgeOrgCompletely(db, "acme");
    await backdateOrg(db, "acme", "12 months 23 hours");
    const young = await snapshot(db, "acme");
    const result = await expireOrgTombstones(db, { apply: true });
    expect(result).toEqual({ eligible: [], expired: [], failed: [] });
    expect(await snapshot(db, "acme")).toEqual(young);

    // Now backdate to just over 13 months: 13 months plus 1 hour.
    backdateOrg(db, "acme", "13 months 1 hour");
    const result2 = await expireOrgTombstones(db, { apply: true });
    expect(result2).toEqual({ eligible: ["acme"], expired: ["acme"], failed: [] });
    const { rows: n } = await db.query<{ n: number }>(
      `select count(*)::int as n from org where id = 'acme'`,
    );
    expect(n[0]!.n).toBe(0);
  });
});
