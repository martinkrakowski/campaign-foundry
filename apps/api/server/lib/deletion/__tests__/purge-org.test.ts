import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import type { SqlClient } from "../../db/sql-client.js";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import {
  InMemoryObjectStore,
  PublicAdMediaStore,
} from "@campaignfoundry/CampaignOrchestration/infrastructure";
import {
  PublicMediaNotConfiguredError,
  type PublicAdMediaPort,
} from "@campaignfoundry/CampaignOrchestration";
import {
  resetObjectStoreClient,
  resetPublicAdMediaClient,
  setObjectStoreClient,
  setPublicAdMediaClient,
} from "../../object-store/index.js";
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
    expect(afterOrg.slug).toBeNull();
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

  test("purgeOrg sets the purged org's slug to null so it cannot collide with another org's slug", async () => {
    await seedOrg(db, "acme", store);
    await seedOrg(db, "beta", store);
    // acme was renamed acme-inc; beta took the free slug `acme` — exactly the
    // collision OD13 warns about: `slug = id` on acme would write `acme` and
    // hit beta's unique slug.
    await db.query(`update org set slug = $1 where id = $2`, ["acme-inc", "acme"]);
    await db.query(`update org set slug = $1 where id = $2`, ["acme", "beta"]);
    const beforeBeta = await snapshot(db, "beta");
    const beforeBetaObj = await objectSnapshot(store, "beta");

    const row = await drainPending("acme");
    const result = await purgeOrg(db, "acme", { id: row.id, requestedBy: row.requestedBy });
    expect(result).toBe("purged");

    const acmeOrg = JSON.parse((await snapshot(db, "acme")).org[0]!);
    expect(acmeOrg.slug).toBeNull();
    expect(acmeOrg.name).toBe("Deleted org");
    // beta is byte-identical: rows and objects.
    expect(await snapshot(db, "beta")).toEqual(beforeBeta);
    expect(await objectSnapshot(store, "beta")).toEqual(beforeBetaObj);
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

  // PT-4k: published clips tie the org to PUBLIC bucket bytes no org-prefix
  // delete covers, so a purge with rows and no public media must refuse, and
  // a configured purge must free the rows AND the public objects.
  describe("purgeOrg and published clips (PT-4k)", () => {
    /** Seed a published_clip row for acme on a BETA campaign (so acme's own
     * campaign purges never hit the cascade-free FK). */
    async function seedPublishedClip(betaCampaignId: string): Promise<void> {
      await db.query(
        `insert into published_clip (org_id, campaign_id, content_hash, key, url)
           values ('acme', $1::uuid, $2, $3, $4)`,
        [
          betaCampaignId,
          "0".repeat(64),
          `acme/${"a".repeat(32)}/${"0".repeat(64)}.mp4`,
          `https://media.test/acme/${"a".repeat(32)}/${"0".repeat(64)}.mp4`,
        ],
      );
    }

    afterEach(() => {
      resetPublicAdMediaClient();
    });

    test("a configured purge removes acme's published_clip rows and public objects and leaves beta untouched", async () => {
      await seedOrg(db, "acme", store);
      await seedOrg(db, "beta", store);
      const beforeBeta = await snapshot(db, "beta");
      const beforeBetaObj = await objectSnapshot(store, "beta");

      const { rows: betaCampaigns } = await db.query<{ id: string }>(
        `select id::text as id from campaign where org_id = 'beta' order by id limit 1`,
      );
      const row = await drainPending("acme");
      // Seeded AFTER the drain: a published_clip row present while public
      // media is unconfigured would refuse the retry pass itself.
      await seedPublishedClip(betaCampaigns[0]!.id);

      const publicStore = new InMemoryObjectStore();
      const publicMedia = new PublicAdMediaStore({
        store: publicStore,
        baseUrl: "https://media.test",
      });
      setPublicAdMediaClient(publicMedia);
      await publicMedia.publish("acme", BYTES, "0".repeat(64));
      await publicMedia.publish("beta", BYTES, "0".repeat(64));

      const result = await purgeOrg(db, "acme", { id: row.id, requestedBy: row.requestedBy });
      expect(result).toBe("purged");

      const { rows: left } = await db.query<{ n: number }>(
        `select count(*)::int as n from published_clip where org_id = 'acme'`,
      );
      expect(left[0]!.n).toBe(0);
      expect(await publicStore.list("acme/")).toHaveLength(0);
      expect(await publicStore.list("beta/")).toHaveLength(1);
      expect(await snapshot(db, "beta")).toEqual(beforeBeta);
      expect(await objectSnapshot(store, "beta")).toEqual(beforeBetaObj);
    });

    test("published_clip rows with unconfigured public media refuse before any delete", async () => {
      await seedOrg(db, "acme", store);
      await seedOrg(db, "beta", store);
      const beforeBeta = await snapshot(db, "beta");

      const { rows: betaCampaigns } = await db.query<{ id: string }>(
        `select id::text as id from campaign where org_id = 'beta' order by id limit 1`,
      );
      const row = await drainPending("acme");
      // Acme has no campaigns of its own left, so the count check no longer
      // answers retry — only the published_clip refusal can stop the sweep.
      await seedPublishedClip(betaCampaigns[0]!.id);
      const beforeAcmeObj = await objectSnapshot(store, "acme");

      await expect(
        purgeOrg(db, "acme", { id: row.id, requestedBy: row.requestedBy }),
      ).rejects.toBeInstanceOf(PublicMediaNotConfiguredError);

      // Nothing was deleted: the ledger row AND the org row are intact.
      const { rows: clips } = await db.query<{ n: number }>(
        `select count(*)::int as n from published_clip where org_id = 'acme'`,
      );
      expect(clips[0]!.n).toBe(1);
      const { rows: orgs } = await db.query<{ n: number }>(
        `select count(*)::int as n from org where id = 'acme'`,
      );
      expect(orgs[0]!.n).toBe(1);
      expect(await snapshot(db, "beta")).toEqual(beforeBeta);
      // deleteOrgObjects never ran either.
      expect(await objectSnapshot(store, "acme")).toEqual(beforeAcmeObj);
    });

    test("a failed public delete leaves the published_clip ledger intact so a retry finds the orphans", async () => {
      await seedOrg(db, "acme", store);
      await seedOrg(db, "beta", store);
      const beforeBeta = await snapshot(db, "beta");

      const { rows: betaCampaigns } = await db.query<{ id: string }>(
        `select id::text as id from campaign where org_id = 'beta' order by id limit 1`,
      );
      const row = await drainPending("acme");
      await seedPublishedClip(betaCampaigns[0]!.id);

      const publicStore = new InMemoryObjectStore();
      const publicMedia = new PublicAdMediaStore({
        store: publicStore,
        baseUrl: "https://media.test",
      });
      await publicMedia.publish("acme", BYTES, "0".repeat(64));
      // The FIRST `removeOrg` fails: the public bytes are still there, and the
      // purge must throw BEFORE dropping the `published_clip` ledger — that
      // ledger is the only record of which public keys are orphaned.
      let removeOrgCalls = 0;
      setPublicAdMediaClient({
        publish: publicMedia.publish.bind(publicMedia),
        remove: publicMedia.remove.bind(publicMedia),
        removeOrg: (orgId: string) => {
          removeOrgCalls += 1;
          if (removeOrgCalls === 1) return Promise.reject(new Error("public bucket unavailable"));
          return publicMedia.removeOrg(orgId);
        },
        urlFor: publicMedia.urlFor.bind(publicMedia),
        listPages: async function* () {},
      } satisfies PublicAdMediaPort);

      const beforeAcme = await snapshot(db, "acme");
      const beforeAcmeObj = await objectSnapshot(store, "acme");

      await expect(
        purgeOrg(db, "acme", { id: row.id, requestedBy: row.requestedBy }),
      ).rejects.toThrow(/public bucket unavailable/);

      // The ledger row survives AND nothing else of the org was deleted.
      const { rows: clips } = await db.query<{ n: number }>(
        `select count(*)::int as n from published_clip where org_id = 'acme'`,
      );
      expect(clips[0]!.n).toBe(1);
      expect(await snapshot(db, "acme")).toEqual(beforeAcme);
      expect(await objectSnapshot(store, "acme")).toEqual(beforeAcmeObj);
      expect(await publicStore.list("acme/")).toHaveLength(1);
      expect(await snapshot(db, "beta")).toEqual(beforeBeta);

      // The retry succeeds and removes both the public objects and the rows.
      const result = await purgeOrg(db, "acme", { id: row.id, requestedBy: row.requestedBy });
      expect(result).toBe("purged");
      const { rows: left } = await db.query<{ n: number }>(
        `select count(*)::int as n from published_clip where org_id = 'acme'`,
      );
      expect(left[0]!.n).toBe(0);
      expect(await publicStore.list("acme/")).toHaveLength(0);
    });

    test("a partially configured public media client throws before any row or object is freed", async () => {
      await seedOrg(db, "acme", store);
      await seedOrg(db, "beta", store);

      const row = await drainPending("acme");
      const beforeAcme = await snapshot(db, "acme");
      const beforeAcmeObj = await objectSnapshot(store, "acme");
      // Partial configuration: PUBLIC_MEDIA_ACCESS_KEY_ID alone makes
      // `publicAdMediaClient()` THROW (a stray variable), which must happen
      // before the published_clip count, before deleteOrgRows and before
      // deleteOrgObjects — acme has ZERO published_clip rows here.
      const savedKey = process.env.PUBLIC_MEDIA_ACCESS_KEY_ID;
      process.env.PUBLIC_MEDIA_ACCESS_KEY_ID = "AKIA-fake";
      try {
        await expect(
          purgeOrg(db, "acme", { id: row.id, requestedBy: row.requestedBy }),
        ).rejects.toThrow(/PUBLIC_MEDIA_ACCESS_KEY_ID/);
      } finally {
        if (savedKey === undefined) delete process.env.PUBLIC_MEDIA_ACCESS_KEY_ID;
        else process.env.PUBLIC_MEDIA_ACCESS_KEY_ID = savedKey;
      }

      // No rows were deleted (usage, provider_key, deletion all intact) and
      // no objects were freed.
      expect(await snapshot(db, "acme")).toEqual(beforeAcme);
      expect(await objectSnapshot(store, "acme")).toEqual(beforeAcmeObj);
    });
  });
});
