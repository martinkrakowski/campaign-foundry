import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import type { SqlClient } from "../../db/sql-client.js";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { resetObjectStoreClient, setObjectStoreClient } from "../../object-store/index.js";
import { orgPrefix } from "../../object-store/object-keys.js";
import { deleteOrgRows, purgeOrg, queueCampaignPurges, requestOrgDeletion } from "../purge-org.js";
import {
  BYTES,
  finishCampaignPurges,
  objectSnapshot,
  orgRow,
  seedOrg,
  snapshot,
} from "./purge-org-fixtures.js";

function saveStore(): string | undefined {
  const saved = process.env.OBJECT_STORE;
  return saved;
}
function restoreStore(saved: string | undefined): void {
  if (saved === undefined) delete process.env.OBJECT_STORE;
  else process.env.OBJECT_STORE = saved;
}

describe("purgeOrg completion (PT-9m2, D241)", () => {
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

  /** requestOrgDeletion + purgeOrg(retry) + finishCampaignPurges, returning the org row. */
  async function drainPending(orgId: string): Promise<{ id: string; requestedBy: string }> {
    await requestOrgDeletion(db, { orgId, requestedBy: "operator" });
    const row = await orgRow(db, orgId);
    expect(await purgeOrg(db, orgId, row)).toBe("retry");
    await finishCampaignPurges(db, orgId);
    return row;
  }

  test("purgeOrg deletes the provider keys of the org and no other org", async () => {
    await seedOrg(db, "acme", store);
    await seedOrg(db, "beta", store);
    const beforeBeta = await snapshot(db, "beta");
    const beforeBetaObj = await objectSnapshot(store, "beta");
    const row = await drainPending("acme");

    await purgeOrg(db, "acme", { id: row.id, requestedBy: row.requestedBy });

    const { rows: acmeKeys } = await db.query<{ n: number }>(
      `select count(*)::int as n from provider_key where org_id = $1`,
      ["acme"],
    );
    expect(acmeKeys[0]!.n).toBe(0);
    const { rows: ct } = await db.query<{ n: number }>(
      `select count(*)::int as n from provider_key where ciphertext = 'ct-acme'`,
    );
    expect(ct[0]!.n).toBe(0);
    expect(await snapshot(db, "beta")).toEqual(beforeBeta);
    expect(await objectSnapshot(store, "beta")).toEqual(beforeBetaObj);
  });

  test("purgeOrg deletes the teams team members invitations and members of the org only", async () => {
    await seedOrg(db, "acme", store);
    await seedOrg(db, "beta", store);
    const beforeBeta = await snapshot(db, "beta");
    const row = await drainPending("acme");

    await purgeOrg(db, "acme", { id: row.id, requestedBy: row.requestedBy });

    for (const table of ["team", "invitation", "member"]) {
      const { rows: c } = await db.query<{ n: number }>(
        `select count(*)::int as n from ${table} where org_id = $1`,
        ["acme"],
      );
      expect(c[0]!.n).toBe(0);
    }
    const { rows: teamMembers } = await db.query<{ n: number }>(
      `select count(*)::int as n from team_member where team_id = 'acme:t'`,
    );
    expect(teamMembers[0]!.n).toBe(0);
    // Q13: users are never erased.
    const { rows: users } = await db.query<{ n: number }>(
      `select count(*)::int as n from "user" where id in ('u-acme-1', 'u-acme-2')`,
    );
    expect(users[0]!.n).toBe(2);
    expect((await snapshot(db, "acme")).team_member).toEqual([]);
    expect(await snapshot(db, "beta")).toEqual(beforeBeta);
  });

  test("purgeOrg deletes leftover slug keyed rows of the org only", async () => {
    await seedOrg(db, "acme", store);
    await seedOrg(db, "beta", store);
    const beforeBeta = await snapshot(db, "beta");
    const row = await drainPending("acme");

    await purgeOrg(db, "acme", { id: row.id, requestedBy: row.requestedBy });

    for (const table of ["decision", "decision_set", "report", "pool", "job"]) {
      const { rows: c } = await db.query<{ n: number }>(
        `select count(*)::int as n from ${table} where org_id = $1 and campaign_id = $2`,
        ["acme", "acme-ghost"],
      );
      expect(c[0]!.n).toBe(0);
    }
    expect(await snapshot(db, "beta")).toEqual(beforeBeta);
  });

  test("purgeOrg anonymises the org row and keeps usage and the tombstone", async () => {
    await seedOrg(db, "acme", store);
    await seedOrg(db, "beta", store);
    const beforeBeta = await snapshot(db, "beta");
    const beforeBetaObj = await objectSnapshot(store, "beta");
    const row = await drainPending("acme");

    // `deleted_at` was set by `requestOrgDeletion` above; the purge must not touch it.
    const beforeAcme = await snapshot(db, "acme");
    const beforeDeletedAt = JSON.parse(beforeAcme.org[0]!).deleted_at;
    const beforeUsage = beforeAcme.usage;

    await purgeOrg(db, "acme", { id: row.id, requestedBy: row.requestedBy });

    const after = await snapshot(db, "acme");
    const afterOrg = JSON.parse(after.org[0]!);
    expect(afterOrg.name).toBe("Deleted org");
    expect(afterOrg.slug).toBe("acme");
    expect(afterOrg.logo).toBeNull();
    expect(afterOrg.metadata).toBeNull();
    expect(afterOrg.deleted_at).toEqual(beforeDeletedAt);
    expect(after.usage).toEqual(beforeUsage);

    expect(await snapshot(db, "beta")).toEqual(beforeBeta);
    expect(await objectSnapshot(store, "beta")).toEqual(beforeBetaObj);
  });

  test("purgeOrg anonymises requested_by on every deletion row of the org only", async () => {
    await seedOrg(db, "acme", store);
    await seedOrg(db, "beta", store);
    const beforeBeta = await snapshot(db, "beta");
    const beforeBetaObj = await objectSnapshot(store, "beta");
    const row = await drainPending("acme");

    await purgeOrg(db, "acme", { id: row.id, requestedBy: row.requestedBy });

    const { rows: acmeDel } = await db.query<{ requested_by: string }>(
      `select requested_by from deletion where org_id = 'acme'`,
    );
    expect(acmeDel.length).toBeGreaterThan(0);
    const tokens = new Set<string>();
    for (const d of acmeDel) {
      expect(d.requested_by).toMatch(
        /^erased:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(d.requested_by).not.toBe("op-acme");
      expect(d.requested_by).not.toBe("operator");
      expect(tokens.has(d.requested_by)).toBe(false);
      tokens.add(d.requested_by);
    }
    expect(await snapshot(db, "beta")).toEqual(beforeBeta);
    expect(await objectSnapshot(store, "beta")).toEqual(beforeBetaObj);
  });

  test("purgeOrg marks the org row purged and a second run changes nothing", async () => {
    await seedOrg(db, "acme", store);
    await seedOrg(db, "beta", store);
    const row = await drainPending("acme");

    const first = await purgeOrg(db, "acme", { id: row.id, requestedBy: row.requestedBy });
    expect(first).toBe("purged");
    const { rows: marked } = await db.query<{ purged_at: Date | null }>(
      `select purged_at from deletion where id = $1`,
      [row.id],
    );
    expect(marked[0]!.purged_at).not.toBeNull();

    const capturedAcme = await snapshot(db, "acme");
    const capturedBeta = await snapshot(db, "beta");
    const capturedAcmeObj = await objectSnapshot(store, "acme");
    const capturedBetaObj = await objectSnapshot(store, "beta");

    const second = await purgeOrg(db, "acme", { id: row.id, requestedBy: "operator" });
    expect(second).toBe("purged");
    expect(await snapshot(db, "acme")).toEqual(capturedAcme);
    expect(await snapshot(db, "beta")).toEqual(capturedBeta);
    expect(await objectSnapshot(store, "acme")).toEqual(capturedAcmeObj);
    expect(await objectSnapshot(store, "beta")).toEqual(capturedBetaObj);

    // Crash replay: a leftover key + a stray object both vanish on the next run.
    await db.query(
      `insert into provider_key (org_id, provider, ciphertext, iv, tag, sealed_dek, dek_iv, dek_tag, kek_version, last4, created_by, created_at)
         values ('acme', 'gemini', 'ct-acme', 'iv', 'tag', 'sd', 'div', 'dtag', 'v1', '0000', 'u-acme-1', now())`,
    );
    await store.put(`${orgPrefix("acme")}crash/x`, BYTES);
    const third = await purgeOrg(db, "acme", { id: row.id, requestedBy: "operator" });
    expect(third).toBe("purged");
    const { rows: leftover } = await db.query<{ n: number }>(
      `select count(*)::int as n from provider_key where org_id = $1`,
      ["acme"],
    );
    expect(leftover[0]!.n).toBe(0);
    expect((await objectSnapshot(store, "acme")).length).toBe(0);
  });

  test("purgeOrg completes at once for an org with no campaigns", async () => {
    await seedOrg(db, "solo", store, { campaigns: 0 });
    await requestOrgDeletion(db, { orgId: "solo", requestedBy: "operator" });
    const row = await orgRow(db, "solo");

    const result = await purgeOrg(db, "solo", { id: row.id, requestedBy: row.requestedBy });
    expect(result).toBe("purged");
  });

  test("purgeOrg refuses a live org and writes nothing", async () => {
    await seedOrg(db, "acme", store);
    await seedOrg(db, "beta", store);
    const beforeAcme = await snapshot(db, "acme");
    const beforeBeta = await snapshot(db, "beta");
    const beforeAcmeObj = await objectSnapshot(store, "acme");
    const beforeBetaObj = await objectSnapshot(store, "beta");
    const fakeRow = { id: randomUUID(), requestedBy: "operator" };

    await expect(purgeOrg(db, "acme", fakeRow)).rejects.toThrow(
      /org "acme" is not tombstoned; refusing to purge it/,
    );

    expect(await snapshot(db, "acme")).toEqual(beforeAcme);
    expect(await snapshot(db, "beta")).toEqual(beforeBeta);
    expect(await objectSnapshot(store, "acme")).toEqual(beforeAcmeObj);
    expect(await objectSnapshot(store, "beta")).toEqual(beforeBetaObj);
  });

  test("purgeOrg refuses the local org and writes nothing", async () => {
    await seedOrg(db, "acme", store);
    await seedOrg(db, "beta", store);
    const beforeLocal = await snapshot(db, "local");
    const fakeRow = { id: randomUUID(), requestedBy: "operator" };

    await expect(purgeOrg(db, "local", fakeRow)).rejects.toThrow(
      /org "local" can never be deleted\./,
    );
    expect(await snapshot(db, "local")).toEqual(beforeLocal);
  });

  test("purgeOrg refuses an unknown org", async () => {
    await seedOrg(db, "acme", store);
    const fakeRow = { id: randomUUID(), requestedBy: "operator" };
    await expect(purgeOrg(db, "ghost", fakeRow)).rejects.toThrow(/unknown org "ghost"/);
  });

  // Finding 2 (PT-9m2-fix1): the exported destructive helpers must refuse `local`
  // just like `purgeOrg` does, and leave the database untouched.
  describe("destructive helpers refuse the local org (PT-9m2-fix1, finding 2)", () => {
    /** Plant rows under `local` in every table `deleteOrgRows` would touch. */
    async function seedLocalRows(): Promise<void> {
      await db.query(
        `insert into "user" (id, name, email, email_verified, image) values ('u-local-1', 'U1', 'l1@example.test', false, null)`,
      );
      await db.query(
        `insert into "user" (id, name, email, email_verified, image) values ('u-local-2', 'U2', 'l2@example.test', false, null)`,
      );
      await db.query(
        `insert into member (id, org_id, user_id, role, created_at) values ('m-local-1', 'local', 'u-local-1', 'member', now())`,
      );
      await db.query(
        `insert into team (id, name, "memberCount", org_id, created_at, updated_at) values ('local:t', 't', 0, 'local', now(), now())`,
      );
      await db.query(
        `insert into team_member (id, team_id, user_id, "membershipKey", created_at) values ('tm-local', 'local:t', 'u-local-1', 'local:t:u1', now())`,
      );
      await db.query(
        `insert into invitation (id, org_id, email, role, team_id, status, expires_at, created_at, inviter_id) values ('inv-local', 'local', 'inv-local@example.test', 'member', null, 'pending', now() + interval '1 day', now(), 'u-local-1')`,
      );
      await db.query(
        `insert into provider_key (org_id, provider, ciphertext, iv, tag, sealed_dek, dek_iv, dek_tag, kek_version, last4, created_by, created_at) values ('local', 'gemini', 'ct-local', 'iv', 'tag', 'sd', 'div', 'dtag', 'v1', '0000', 'u-local-1', now())`,
      );
      await db.query(
        `insert into usage (org_id, provider, model, units, key_owner) values ('local', 'gemini', 'm', 1, 'platform')`,
      );
    }

    test("deleteOrgRows refuses the local org and writes nothing", async () => {
      await seedLocalRows();
      const before = await snapshot(db, "local");

      await expect(deleteOrgRows(db, "local")).rejects.toThrow(
        /org "local" can never be deleted\./,
      );
      // Every seeded row survives: the refusal happened before any delete.
      expect(await snapshot(db, "local")).toEqual(before);
    });

    test("queueCampaignPurges refuses the local org and writes nothing", async () => {
      await seedOrg(db, "acme", store);
      const beforeAcme = await snapshot(db, "acme");
      const beforeAcmeObj = await objectSnapshot(store, "acme");

      await expect(queueCampaignPurges(db, "local", "operator")).rejects.toThrow(
        /org "local" can never be deleted\./,
      );
      // The local org has no campaigns, but the call must refuse before it reads
      // any table — and acme is untouched.
      expect(await snapshot(db, "acme")).toEqual(beforeAcme);
      expect(await objectSnapshot(store, "acme")).toEqual(beforeAcmeObj);
    });
  });

  // Finding 3 (PT-9m2-fix1): a deletion id that names no row (or a foreign row)
  // must be rejected before any org row or byte is touched.
  describe("purgeOrg validates its deletion row before doing anything (PT-9m2-fix1, finding 3)", () => {
    test("an id naming no row throws and the org's rows and objects are untouched", async () => {
      await seedOrg(db, "acme", store);
      await seedOrg(db, "beta", store);
      // Acme is tombstoned first; the bogus id must still be rejected before any
      // row or object is freed.
      await requestOrgDeletion(db, { orgId: "acme", requestedBy: "operator" });
      const beforeAcme = await snapshot(db, "acme");
      const beforeAcmeObj = await objectSnapshot(store, "acme");
      const beforeBeta = await snapshot(db, "beta");
      const beforeBetaObj = await objectSnapshot(store, "beta");

      const bogus = randomUUID();
      await expect(purgeOrg(db, "acme", { id: bogus, requestedBy: "operator" })).rejects.toThrow(
        `unknown deletion row "${bogus}"`,
      );
      // No rows and no objects were freed.
      expect(await snapshot(db, "acme")).toEqual(beforeAcme);
      expect(await objectSnapshot(store, "acme")).toEqual(beforeAcmeObj);
      expect(await snapshot(db, "beta")).toEqual(beforeBeta);
      expect(await objectSnapshot(store, "beta")).toEqual(beforeBetaObj);
    });

    test("a row of kind campaign throws and nothing is touched", async () => {
      await seedOrg(db, "acme", store);
      await seedOrg(db, "beta", store);
      await requestOrgDeletion(db, { orgId: "acme", requestedBy: "operator" });
      // A `kind = 'campaign'` deletion row belonging to acme.
      const { rows } = await db.query<{ id: string }>(
        `insert into deletion (org_id, kind, subject, requested_by, not_before)
           values ('acme', 'campaign', '00000000-0000-4000-8000-000000000000', 'someone', now())
         returning id`,
      );
      const campaignDelId = rows[0]!.id;
      const beforeAcme = await snapshot(db, "acme");
      const beforeAcmeObj = await objectSnapshot(store, "acme");
      const beforeBeta = await snapshot(db, "beta");
      const beforeBetaObj = await objectSnapshot(store, "beta");

      await expect(
        purgeOrg(db, "acme", { id: campaignDelId, requestedBy: "operator" }),
      ).rejects.toThrow(`deletion row "${campaignDelId}" is not this org's purge`);
      expect(await snapshot(db, "acme")).toEqual(beforeAcme);
      expect(await objectSnapshot(store, "acme")).toEqual(beforeAcmeObj);
      expect(await snapshot(db, "beta")).toEqual(beforeBeta);
      expect(await objectSnapshot(store, "beta")).toEqual(beforeBetaObj);
    });

    test("another org's org row throws and nothing is touched", async () => {
      await seedOrg(db, "acme", store);
      await seedOrg(db, "beta", store);
      // Acme is tombstoned (its own row is valid); beta's org deletion row is foreign.
      await requestOrgDeletion(db, { orgId: "acme", requestedBy: "operator" });
      await requestOrgDeletion(db, { orgId: "beta", requestedBy: "operator" });
      const betaOrgRow = await orgRow(db, "beta");
      const beforeAcme = await snapshot(db, "acme");
      const beforeAcmeObj = await objectSnapshot(store, "acme");
      const beforeBeta = await snapshot(db, "beta");
      const beforeBetaObj = await objectSnapshot(store, "beta");

      await expect(
        purgeOrg(db, "acme", { id: betaOrgRow.id, requestedBy: "operator" }),
      ).rejects.toThrow(`deletion row "${betaOrgRow.id}" is not this org's purge`);
      expect(await snapshot(db, "acme")).toEqual(beforeAcme);
      expect(await objectSnapshot(store, "acme")).toEqual(beforeAcmeObj);
      expect(await snapshot(db, "beta")).toEqual(beforeBeta);
      expect(await objectSnapshot(store, "beta")).toEqual(beforeBetaObj);
    });
  });
});
