import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import type { ObjectStorePort } from "@campaignfoundry/CampaignOrchestration";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import type { SqlClient } from "../../db/sql-client.js";
import { campaignPrefix } from "../../object-store/object-keys.js";
import {
  ORPHAN_MIN_AGE_MS,
  applyReconcilePlan,
  planReconcile,
  reconcileOrgs,
  type ReconcilePlan,
} from "../reconcile.js";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const C1 = "c1c1c1c1-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const C2 = "c2c2c2c2-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const C3 = "c3c3c3c3-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const A1 = "a1a1a1a1-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const A2 = "a2a2a2a2-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const ORG = "local";

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

async function seedAsset(
  db: SqlClient,
  orgId: string,
  campaignId: string,
  assetId: string,
): Promise<void> {
  await db.query(
    `insert into asset (id, org_id, campaign_id, kind, name, size, sha256, content_type)
      values ($1::uuid, $2, $3::uuid, 'input', $4, 1, 'h', 'image/png')`,
    [assetId, orgId, campaignId, `asset-${assetId}.png`],
  );
}

let clock: number;
let store: InMemoryObjectStore;

async function putAt(key: string, at: number): Promise<void> {
  clock = at;
  await store.put(key, new Uint8Array([1]));
  clock = NOW;
}

describe("reconcile (D239)", () => {
  let db: SqlClient;

  beforeEach(async () => {
    clock = NOW;
    store = new InMemoryObjectStore({ now: () => clock });
    db = await migratedDatabase();
    await db.query(`insert into org (id, name) values ('acme', 'Acme')`);
  }, 30_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.end();
  });

  test("reconcile plans an orphan prefix older than one hour", async () => {
    const prefix = campaignPrefix(ORG, C1);
    await putAt(`${prefix}inputs/${A1}`, NOW - 2 * HOUR);
    await putAt(`${prefix}renders/alpha/1x1/v1.png`, NOW - 2 * HOUR);
    await putAt(`${prefix}packages/instagram-feed/1/p.zip`, NOW - 2 * HOUR);

    const plan = await planReconcile(db, store, ORG, NOW);
    expect(plan).toEqual({
      orgId: "local",
      prefixes: [{ campaignId: C1, objects: 3 }],
      inputs: [],
    });
    expect((await store.list("org/")).map((o) => o.key).sort()).toEqual([
      `${prefix}inputs/${A1}`,
      `${prefix}packages/instagram-feed/1/p.zip`,
      `${prefix}renders/alpha/1x1/v1.png`,
    ]);
  });

  test("reconcile keeps a fresh orphan prefix", async () => {
    const prefix = campaignPrefix(ORG, C1);
    await putAt(`${prefix}inputs/${A1}`, NOW - HOUR / 2);
    await putAt(`${prefix}renders/alpha/1x1/v1.png`, NOW - HOUR / 2);
    await putAt(`${prefix}packages/instagram-feed/1/p.zip`, NOW - HOUR / 2);

    const plan = await planReconcile(db, store, ORG, NOW);
    expect(plan.prefixes).toEqual([]);
    expect(plan.inputs).toEqual([]);
  });

  test("reconcile keeps an orphan prefix when one object in it is fresh", async () => {
    const prefix = campaignPrefix(ORG, C1);
    await putAt(`${prefix}inputs/${A1}`, NOW - 2 * HOUR);
    await putAt(`${prefix}renders/alpha/1x1/v1.png`, NOW - 5 * 60_000);

    const plan = await planReconcile(db, store, ORG, NOW);
    expect(plan.prefixes).toEqual([]);
  });

  test("reconcile treats exactly one hour as fresh and one hour plus one millisecond as old", async () => {
    expect(ORPHAN_MIN_AGE_MS).toBe(3_600_000);

    await putAt(`${campaignPrefix(ORG, C1)}renders/x.png`, NOW - HOUR);
    await putAt(`${campaignPrefix(ORG, C2)}renders/x.png`, NOW - HOUR - 1);
    await putAt(`${campaignPrefix(ORG, C3)}renders/x.png`, NOW + HOUR);

    const plan = await planReconcile(db, store, ORG, NOW);
    expect(plan.prefixes).toEqual([{ campaignId: C2, objects: 1 }]);
  });

  test("reconcile keeps every object of a live campaign even when old", async () => {
    const campaignId = await seedCampaign(db, ORG, "live", { id: C1 });
    await seedAsset(db, ORG, campaignId, A1);
    const prefix = campaignPrefix(ORG, campaignId);
    await putAt(`${prefix}inputs/${A1}`, NOW - 5 * HOUR);
    await putAt(`${prefix}renders/alpha/1x1/v1.png`, NOW - 5 * HOUR);
    await putAt(`${prefix}packages/instagram-feed/1/p.zip`, NOW - 5 * HOUR);

    const plan = await planReconcile(db, store, ORG, NOW);
    expect(plan.prefixes).toEqual([]);
    expect(plan.inputs).toEqual([]);
  });

  test("reconcile plans an input with no asset row older than one hour for a live campaign", async () => {
    const campaignId = await seedCampaign(db, ORG, "live", { id: C1 });
    await seedAsset(db, ORG, campaignId, A1);
    const prefix = campaignPrefix(ORG, campaignId);
    await putAt(`${prefix}inputs/${A1}`, NOW - 5 * HOUR);
    await putAt(`${prefix}inputs/${A2}`, NOW - 5 * HOUR);
    await putAt(`${prefix}renders/alpha/1x1/v1.png`, NOW - 5 * HOUR);

    const plan = await planReconcile(db, store, ORG, NOW);
    expect(plan.inputs).toEqual([{ campaignId, assetId: A2 }]);
    expect(plan.prefixes).toEqual([]);
  });

  test("reconcile keeps a fresh input with no asset row", async () => {
    const campaignId = await seedCampaign(db, ORG, "live", { id: C1 });
    const prefix = campaignPrefix(ORG, campaignId);
    await putAt(`${prefix}inputs/${A2}`, NOW - HOUR / 2);

    const plan = await planReconcile(db, store, ORG, NOW);
    expect(plan.inputs).toEqual([]);
  });

  test("reconcile keeps every object of a tombstoned campaign for the purge", async () => {
    const campaignId = await seedCampaign(db, ORG, "tomb", { id: C1, tombstoned: true });
    const prefix = campaignPrefix(ORG, campaignId);
    await putAt(`${prefix}inputs/${A1}`, NOW - 5 * HOUR);
    await putAt(`${prefix}renders/alpha/1x1/v1.png`, NOW - 5 * HOUR);

    const plan = await planReconcile(db, store, ORG, NOW);
    expect(plan.prefixes).toEqual([]);
    expect(plan.inputs).toEqual([]);
  });

  test("reconcile does not let another campaigns asset row vouch for an input", async () => {
    const xId = await seedCampaign(db, ORG, "x", { id: C1, tombstoned: false });
    const yId = await seedCampaign(db, ORG, "y", { id: C2, tombstoned: false });
    await seedAsset(db, ORG, yId, A1);

    const prefix = campaignPrefix(ORG, xId);
    await putAt(`${prefix}inputs/${A1}`, NOW - 5 * HOUR);

    const plan = await planReconcile(db, store, ORG, NOW);
    expect(plan.inputs).toEqual([{ campaignId: xId, assetId: A1 }]);
  });

  test("reconcile reads the rows after it lists the objects", async () => {
    const inputKey1 = `${campaignPrefix(ORG, C1)}renders/alpha/1x1/v1.png`;
    const inputKey2 = `${campaignPrefix(ORG, C1)}packages/instagram-feed/1/p.zip`;
    clock = NOW - 5 * HOUR;
    await store.put(inputKey1, new Uint8Array([1]));
    await store.put(inputKey2, new Uint8Array([1]));
    clock = NOW;

    const spy = vi.spyOn(store, "list").mockImplementation(async (prefix) => {
      const listed = await InMemoryObjectStore.prototype.list.call(store, prefix);
      await seedCampaign(db, ORG, "late", { id: C1 });
      return listed;
    });

    const plan = await planReconcile(db, store, ORG, NOW);
    expect(spy).toHaveBeenCalled();
    expect(plan.prefixes).toEqual([]);
    expect(plan.inputs).toEqual([]);
  });

  test("reconcile plans only the org it is given", async () => {
    await putAt(`${campaignPrefix(ORG, C1)}renders/x.png`, NOW - 5 * HOUR);
    await putAt(`${campaignPrefix("acme", C2)}renders/x.png`, NOW - 5 * HOUR);
    await putAt(`org/ghost/campaign/${C3}/renders/x.png`, NOW - 5 * HOUR);

    const plan = await planReconcile(db, store, "acme", NOW);
    expect(plan.prefixes).toEqual([{ campaignId: C2, objects: 1 }]);

    const result = await reconcileOrgs(db, store, ["local", "acme"], {
      apply: true,
      now: () => NOW,
    });
    expect(result.applied.prefixes).toBe(2);
    expect(result.applied.inputs).toBe(0);
    expect(await store.list("org/ghost/campaign/")).toHaveLength(1);
  });

  test("reconcile aborts on a key outside the alphabet and deletes nothing", async () => {
    const badKeys = [
      `org/local/campaign/not-a-uuid/inputs/${A1}`,
      `org/local/campaign/${C1.toUpperCase()}/inputs/${A1}`,
      `org/local/campaign/${C1}`,
      `org/local/campaign/${C1}/other/x`,
      `org/local/campaign/${C1}/inputs/not-a-uuid`,
      `org/local/campaign/${C1}/inputs/${A1}/extra`,
    ];
    const cannotPlant = [
      `org/local/campaign/${C1}/renders/a//b`,
      `org/local/campaign/${C1}/renders/./x`,
    ];

    for (const key of badKeys) {
      const s = new InMemoryObjectStore({ now: () => NOW - 5 * HOUR });
      await s.put(key, new Uint8Array([1]));
      await expect(
        reconcileOrgs(db, s, ["local"], { apply: true, now: () => NOW }),
      ).rejects.toThrow("outside the object key alphabet");
      expect((await s.list("org/")).length).toBe(1);
    }

    for (const key of cannotPlant) {
      const stub = {
        list: async () => [{ key, size: 1, lastModified: new Date(NOW - 5 * HOUR) }],
        deletePrefix: vi.fn(),
        delete: vi.fn(),
      } as unknown as ObjectStorePort;
      await expect(
        reconcileOrgs(db, stub, ["local"], { apply: true, now: () => NOW }),
      ).rejects.toThrow("outside the object key alphabet");
      expect(stub.deletePrefix).not.toHaveBeenCalled();
      expect(stub.delete).not.toHaveBeenCalled();
    }

    // A valid orphan plus a bad key: all orgs are planned before the first delete.
    const s = new InMemoryObjectStore({ now: () => NOW - 5 * HOUR });
    await s.put(`org/acme/campaign/${C2}/inputs/${A1}`, new Uint8Array([1]));
    await s.put(`org/local/campaign/${C1.toUpperCase()}/inputs/${A1}`, new Uint8Array([1]));
    await expect(
      reconcileOrgs(db, s, ["acme", "local"], { apply: true, now: () => NOW }),
    ).rejects.toThrow("outside the object key alphabet");
    expect((await s.list("org/")).length).toBe(2);
  });

  test("reconcile aborts when the store lists a key outside the org prefix", async () => {
    const stub = {
      list: async () => [
        {
          key: `org/other/campaign/${C1}/inputs/${A1}`,
          size: 1,
          lastModified: new Date(NOW - 5 * HOUR),
        },
      ],
      deletePrefix: vi.fn(),
      delete: vi.fn(),
    } as unknown as ObjectStorePort;

    await expect(
      reconcileOrgs(db, stub, ["local"], { apply: true, now: () => NOW }),
    ).rejects.toThrow("outside the object key alphabet");
    expect(stub.deletePrefix).not.toHaveBeenCalled();
    expect(stub.delete).not.toHaveBeenCalled();
  });

  test("reconcile dry run deletes nothing", async () => {
    // An orphan prefix (no campaign row)
    const prefix = campaignPrefix(ORG, C1);
    await putAt(`${prefix}inputs/${A1}`, NOW - 5 * HOUR);
    await putAt(`${prefix}renders/alpha/1x1/v1.png`, NOW - 5 * HOUR);

    // An orphan input (live campaign, no asset row)
    const liveId = await seedCampaign(db, ORG, "live", { id: C2, tombstoned: false });
    await putAt(`${campaignPrefix(ORG, liveId)}inputs/${A2}`, NOW - 5 * HOUR);

    const beforeKeys = (await store.list("org/")).map((o) => o.key).sort();

    const result = await reconcileOrgs(db, store, ["local"], { apply: false, now: () => NOW });
    expect(result.plans[0].prefixes).toHaveLength(1);
    expect(result.plans[0].inputs).toHaveLength(1);
    expect(result.applied).toEqual({ prefixes: 0, inputs: 0, skipped: 0 });

    const afterKeys = (await store.list("org/")).map((o) => o.key).sort();
    expect(afterKeys).toEqual(beforeKeys);
  });

  test("reconcile apply deletes only the planned orphans", async () => {
    // Old orphan prefix (3 objects) for local
    const oldOrphanPrefix = campaignPrefix(ORG, C1);
    await putAt(`${oldOrphanPrefix}inputs/${A1}`, NOW - 5 * HOUR);
    await putAt(`${oldOrphanPrefix}renders/alpha/1x1/v1.png`, NOW - 5 * HOUR);
    await putAt(`${oldOrphanPrefix}packages/instagram-feed/1/p.zip`, NOW - 5 * HOUR);

    // Fresh orphan prefix
    const freshPrefix = campaignPrefix(ORG, C2);
    await putAt(`${freshPrefix}inputs/${A1}`, NOW - HOUR / 2);

    // Live campaign with old render + vouched input + orphan input
    const liveId = await seedCampaign(db, ORG, "live", { id: C3, tombstoned: false });
    await seedAsset(db, ORG, liveId, A1);
    const livePrefix = campaignPrefix(ORG, liveId);
    await putAt(`${livePrefix}renders/alpha/1x1/v1.png`, NOW - 5 * HOUR);
    await putAt(`${livePrefix}inputs/${A1}`, NOW - 5 * HOUR);
    await putAt(`${livePrefix}inputs/${A2}`, NOW - 5 * HOUR);

    // Tombstoned campaign's old objects
    const tombId = await seedCampaign(db, ORG, "tomb", {
      id: "11111111-aaaa-4aaa-8aaa-111111111111",
      tombstoned: true,
    });
    const tombPrefix = campaignPrefix(ORG, tombId);
    await putAt(`${tombPrefix}inputs/${A1}`, NOW - 5 * HOUR);

    // Org cache object (outside campaign shape)
    await putAt(`org/${ORG}/cache/${"c".repeat(64)}.png`, NOW - 5 * HOUR);

    // Acme's orphan prefix
    const acmePrefix = campaignPrefix("acme", C1);
    await putAt(`${acmePrefix}inputs/${A1}`, NOW - 5 * HOUR);

    const result = await reconcileOrgs(db, store, ["local"], { apply: true, now: () => NOW });
    expect(result.applied).toEqual({ prefixes: 1, inputs: 1, skipped: 0 });

    const before = (await store.list("org/")).map((o) => o.key).sort();
    const expected = [
      `${freshPrefix}inputs/${A1}`,
      `${livePrefix}renders/alpha/1x1/v1.png`,
      `${livePrefix}inputs/${A1}`,
      `${tombPrefix}inputs/${A1}`,
      `org/${ORG}/cache/${"c".repeat(64)}.png`,
      `${acmePrefix}inputs/${A1}`,
    ].sort();
    expect(before).toEqual(expected);
  });

  test("reconcile apply skips an orphan prefix whose campaign row appeared after the plan", async () => {
    const prefix = campaignPrefix(ORG, C1);
    await putAt(`${prefix}inputs/${A1}`, NOW - 5 * HOUR);
    await putAt(`${prefix}renders/alpha/1x1/v1.png`, NOW - 5 * HOUR);

    const plan: ReconcilePlan = await planReconcile(db, store, ORG, NOW);
    await seedCampaign(db, ORG, "late", { id: C1, tombstoned: false });

    const result = await applyReconcilePlan(db, store, plan);
    expect(result).toEqual({ prefixes: 0, inputs: 0, skipped: 1 });
    const before = (await store.list("org/")).map((o) => o.key).sort();
    expect(before).toHaveLength(2);
  });

  test("reconcile apply skips an input whose asset row appeared after the plan", async () => {
    const campaignId = await seedCampaign(db, ORG, "live", { id: C1, tombstoned: false });
    const prefix = campaignPrefix(ORG, C1);
    await putAt(`${prefix}inputs/${A2}`, NOW - 5 * HOUR);

    const plan: ReconcilePlan = await planReconcile(db, store, ORG, NOW);
    await seedAsset(db, ORG, campaignId, A2);

    const result = await applyReconcilePlan(db, store, plan);
    expect(result).toEqual({ prefixes: 0, inputs: 0, skipped: 1 });
    const before = (await store.list("org/")).map((o) => o.key).sort();
    expect(before).toEqual([`${prefix}inputs/${A2}`]);
  });
});
