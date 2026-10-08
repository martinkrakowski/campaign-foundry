import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import type { ListedObject, ObjectStorePort } from "@campaignfoundry/CampaignOrchestration";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import type { SqlClient, SqlQuery } from "../../db/sql-client.js";
import { campaignPrefix, inputKey } from "../../object-store/object-keys.js";
import {
  ORPHAN_MIN_AGE_MS,
  ROW_QUERY_CHUNK,
  applyReconcilePlan,
  describePlan,
  describeStep,
  planReconcile,
  reconcileOrgs,
  type ReconcilePlan,
  type ReconcileStep,
} from "../reconcile.js";

const uuidN = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

function recording(db: SqlClient): {
  sql: SqlQuery;
  calls: { text: string; params: readonly unknown[] }[];
} {
  const calls: { text: string; params: readonly unknown[] }[] = [];
  const sql = {
    query: (text: string, params: readonly unknown[] = []) => {
      calls.push({ text, params });
      return db.query(text, params);
    },
    exec: (text: string) => db.exec(text),
  } as SqlQuery;
  return { sql, calls };
}

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

    const spy = vi.spyOn(store, "listPages").mockImplementation(async function* (
      prefix: string,
    ): AsyncGenerator<readonly ListedObject[]> {
      yield* InMemoryObjectStore.prototype.listPages.call(store, prefix);
      await seedCampaign(db, ORG, "late", { id: C1 });
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
    expect(await store.list("org/acme/campaign/")).toHaveLength(0);
    expect(await store.list("org/local/campaign/")).toHaveLength(0);
  });

  test("reconcile apply rechecks the row in the plans own org", async () => {
    const prefix = campaignPrefix("acme", C2);
    await putAt(`${prefix}inputs/${A1}`, NOW - 5 * HOUR);
    await putAt(`${prefix}renders/alpha/1x1/v1.png`, NOW - 5 * HOUR);

    const plan = await planReconcile(db, store, "acme", NOW);
    expect(plan.prefixes).toEqual([{ campaignId: C2, objects: 2 }]);

    await seedCampaign(db, "acme", "late-acme", { id: C2 });

    const result = await applyReconcilePlan(db, store, plan);
    expect(result).toEqual({ prefixes: 0, inputs: 0, skipped: 1 });
    expect((await store.list("org/acme/campaign/")).map((o) => o.key).sort()).toEqual([
      `${prefix}inputs/${A1}`,
      `${prefix}renders/alpha/1x1/v1.png`,
    ]);

    // Second half: the delete goes to the plan's own org, not a hardcoded one.
    // Clear the first half's objects so only C3 is visible to the plan.
    await store.deletePrefix(campaignPrefix("acme", C2));
    const prefix2 = campaignPrefix("acme", C3);
    await putAt(`${prefix2}inputs/${A1}`, NOW - 5 * HOUR);
    const plan2 = await planReconcile(db, store, "acme", NOW);
    expect(plan2.prefixes).toEqual([{ campaignId: C3, objects: 1 }]);
    const result2 = await applyReconcilePlan(db, store, plan2);
    expect(result2).toEqual({ prefixes: 1, inputs: 0, skipped: 0 });
    expect(await store.list(campaignPrefix("acme", C3))).toHaveLength(0);
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
        listPages: async function* () {
          yield [{ key, size: 1, lastModified: new Date(NOW - 5 * HOUR) }];
        },
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
      listPages: async function* () {
        yield [
          {
            key: `org/other/campaign/${C1}/inputs/${A1}`,
            size: 1,
            lastModified: new Date(NOW - 5 * HOUR),
          },
        ];
      },
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

  test("reconcile asks the database about the listed campaigns only", async () => {
    for (let i = 0; i < 30; i++) await seedCampaign(db, "local", `other-${i}`);
    const c1Object = inputKey(ORG, C1, A1);
    await putAt(c1Object, NOW - 5 * HOUR);
    await seedCampaign(db, "local", "mine", { id: C2 });
    await seedAsset(db, "local", C2, A1);
    const c2Object = inputKey(ORG, C2, A1);
    await putAt(c2Object, NOW - 5 * HOUR);

    const { sql, calls } = recording(db);
    const plan = await planReconcile(sql, store, "local", NOW);

    expect(calls.length).toBe(2);
    for (const call of calls) {
      expect(call.params[0]).toBe("local");
      expect(call.params[1]).toEqual([C1, C2]);
      expect(call.text).toContain("any($2::uuid[])");
    }
    expect(plan).toEqual({
      orgId: "local",
      prefixes: [{ campaignId: C1, objects: 1 }],
      inputs: [],
    });
  });

  test("reconcile sends no row query when nothing is listed", async () => {
    const { sql, calls } = recording(db);
    const plan = await planReconcile(sql, store, "local", NOW);
    expect(plan).toEqual({ orgId: "local", prefixes: [], inputs: [] });
    expect(calls.length).toBe(0);
  });

  test("reconcile reads rows in chunks and still sees a campaign past the first chunk", async () => {
    expect(ROW_QUERY_CHUNK).toBe(500);

    clock = NOW - 5 * HOUR;
    for (let i = 0; i <= 1200; i++) {
      await store.put(`${campaignPrefix("local", uuidN(i))}inputs/${A1}`, new Uint8Array([1]));
    }
    clock = NOW;

    for (const i of [0, 499, 500, 1200]) {
      await seedCampaign(db, "local", `live-${i}`, { id: uuidN(i) });
    }

    const { sql, calls } = recording(db);
    const plan = await planReconcile(sql, store, "local", NOW);

    expect(plan.prefixes.length).toBe(1197);
    for (const id of [uuidN(0), uuidN(499), uuidN(500), uuidN(1200)]) {
      expect(plan.prefixes.map((p) => p.campaignId)).not.toContain(id);
    }
    expect(plan.inputs).toHaveLength(4);
    expect(plan.inputs.map((i) => i.campaignId).sort()).toEqual(
      [uuidN(0), uuidN(499), uuidN(500), uuidN(1200)].sort(),
    );

    expect(calls.length).toBe(6);
    expect((calls[0].params[1] as string[]).length).toBe(500);
    expect((calls[2].params[1] as string[]).length).toBe(500);
    expect((calls[4].params[1] as string[]).length).toBe(201);
  }, 60_000);

  test("reconcile reports every org plan before the first delete and each delete as it completes", async () => {
    const prefixLocalC1 = campaignPrefix(ORG, C1);
    await putAt(inputKey(ORG, C1, A1), NOW - 5 * HOUR);
    await seedCampaign(db, ORG, "live", { id: C2 });
    await putAt(inputKey(ORG, C2, A2), NOW - 5 * HOUR);

    const prefixAcmeC3 = campaignPrefix("acme", C3);
    await putAt(`${prefixAcmeC3}renders/alpha/1x1/v1.png`, NOW - 5 * HOUR);

    const events: string[] = [];
    const realDeletePrefix = store.deletePrefix.bind(store);
    const realDelete = store.delete.bind(store);
    vi.spyOn(store, "deletePrefix").mockImplementation(async (p) => {
      events.push(`store deletePrefix ${p}`);
      await realDeletePrefix(p);
    });
    vi.spyOn(store, "delete").mockImplementation(async (k) => {
      events.push(`store delete ${k}`);
      await realDelete(k);
    });

    await reconcileOrgs(db, store, ["local", "acme"], {
      apply: true,
      now: () => NOW,
      onPlan: (plan) => events.push(`plan ${plan.orgId}`),
      onStep: (step) => events.push(`step ${step.outcome} ${step.kind} ${step.key}`),
    });

    expect(events).toEqual([
      "plan local",
      "plan acme",
      `store deletePrefix ${prefixLocalC1}`,
      `step deleted prefix ${prefixLocalC1}`,
      `store delete ${inputKey(ORG, C2, A2)}`,
      `step deleted input ${inputKey(ORG, C2, A2)}`,
      `store deletePrefix ${prefixAcmeC3}`,
      `step deleted prefix ${prefixAcmeC3}`,
    ]);
  });

  test("reconcile keeps the record of the deletes that completed when a later delete fails", async () => {
    const prefixC1 = campaignPrefix(ORG, C1);
    await putAt(inputKey(ORG, C1, A1), NOW - 5 * HOUR);
    await putAt(inputKey(ORG, C3, A1), NOW - 5 * HOUR);

    let call = 0;
    const realDeletePrefix = store.deletePrefix.bind(store);
    vi.spyOn(store, "deletePrefix").mockImplementation(async (p) => {
      if (call++ === 0) return realDeletePrefix(p);
      throw new Error("store down");
    });

    const steps: ReconcileStep[] = [];
    await expect(
      reconcileOrgs(db, store, ["local"], {
        apply: true,
        now: () => NOW,
        onStep: (s) => steps.push(s),
      }),
    ).rejects.toThrow("store down");

    expect(steps).toEqual([{ kind: "prefix", key: prefixC1, outcome: "deleted" }]);
    expect((await store.list(campaignPrefix(ORG, C3))).map((o) => o.key).sort()).toEqual([
      inputKey(ORG, C3, A1),
    ]);
  });

  test("reconcile reports a candidate whose row appeared as skipped", async () => {
    await putAt(inputKey(ORG, C1, A1), NOW - 5 * HOUR);
    await seedCampaign(db, ORG, "live", { id: C2 });
    await putAt(inputKey(ORG, C2, A2), NOW - 5 * HOUR);

    const plan = await planReconcile(db, store, ORG, NOW);
    expect(plan.prefixes).toEqual([{ campaignId: C1, objects: 1 }]);
    expect(plan.inputs).toEqual([{ campaignId: C2, assetId: A2 }]);

    await seedCampaign(db, "local", "late", { id: C1 });
    await seedAsset(db, "local", C2, A2);

    const steps: ReconcileStep[] = [];
    const result = await applyReconcilePlan(db, store, plan, (s) => steps.push(s));
    expect(result).toEqual({ prefixes: 0, inputs: 0, skipped: 2 });
    expect(steps).toEqual([
      { kind: "prefix", key: campaignPrefix(ORG, C1), outcome: "skipped" },
      { kind: "input", key: inputKey(ORG, C2, A2), outcome: "skipped" },
    ]);
    expect((await store.list("org/local/campaign/")).map((o) => o.key).sort()).toEqual(
      [inputKey(ORG, C1, A1), inputKey(ORG, C2, A2)].sort(),
    );
  });

  test("reconcile refuses to apply more candidates than the cap and deletes nothing", async () => {
    await putAt(inputKey(ORG, C1, A1), NOW - 5 * HOUR);
    await putAt(inputKey(ORG, C2, A1), NOW - 5 * HOUR);
    await putAt(inputKey(ORG, C3, A1), NOW - 5 * HOUR);

    const before = (await store.list("org/local/campaign/")).map((o) => o.key).sort();

    let threw: string | undefined;
    try {
      await reconcileOrgs(db, store, ["local"], {
        apply: true,
        now: () => NOW,
        maxCandidates: 2,
      });
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    expect(threw).toMatch(/exceed the cap of 2/);
    expect(threw).not.toContain(C1);
    expect((await store.list("org/local/campaign/")).map((o) => o.key).sort()).toEqual(before);

    const dry = await reconcileOrgs(db, store, ["local"], {
      apply: false,
      now: () => NOW,
      maxCandidates: 0,
    });
    expect(dry.plans[0].prefixes.length).toBe(3);
    expect(dry.applied).toEqual({ prefixes: 0, inputs: 0, skipped: 0 });

    const applied = await reconcileOrgs(db, store, ["local"], {
      apply: true,
      now: () => NOW,
      maxCandidates: 3,
    });
    expect(applied.applied.prefixes).toBe(3);
    expect(await store.list("org/local/campaign/")).toHaveLength(0);
  });

  test("reconcile describes a plan and a step as the lines the CLI logs", () => {
    expect(
      describePlan({
        orgId: "local",
        prefixes: [{ campaignId: C1, objects: 3 }],
        inputs: [{ campaignId: C2, assetId: A2 }],
      }),
    ).toEqual([
      `  org local: 1 orphan prefix(es), 1 orphan input(s)`,
      `    prefix ${campaignPrefix("local", C1)} (3 object(s))`,
      `    input ${inputKey("local", C2, A2)}`,
    ]);
    expect(describeStep({ kind: "prefix", key: "k1", outcome: "deleted" })).toBe(
      "  deleted prefix k1",
    );
    expect(describeStep({ kind: "input", key: "k2", outcome: "skipped" })).toBe(
      "  skipped input k2 (a row appeared)",
    );
  });

  test("reconcile keeps an orphan prefix whose fresh object arrives on a later page", async () => {
    const paged = new InMemoryObjectStore({ now: () => clock, listPageSize: 1 });
    async function putAt(key: string, at: number): Promise<void> {
      clock = at;
      await paged.put(key, new Uint8Array([1]));
      clock = NOW;
    }
    const c1 = campaignPrefix(ORG, C1);
    const c2 = campaignPrefix(ORG, C2);
    await putAt(`${c1}renders/alpha/1x1/v1.png`, NOW - 5 * HOUR);
    await putAt(`${c2}renders/alpha/1x1/v1.png`, NOW - 5 * HOUR);
    await putAt(`${c1}renders/alpha/1x1/v2.png`, NOW - 10 * 60_000);

    const plan = await planReconcile(db, paged, ORG, NOW);
    expect(plan.prefixes).toEqual([{ campaignId: C2, objects: 1 }]);
  });

  test("reconcile counts an orphan prefix across pages", async () => {
    const paged = new InMemoryObjectStore({ now: () => clock, listPageSize: 1 });
    async function putAt(key: string, at: number): Promise<void> {
      clock = at;
      await paged.put(key, new Uint8Array([1]));
      clock = NOW;
    }
    const c1 = campaignPrefix(ORG, C1);
    const c2 = campaignPrefix(ORG, C2);
    await seedCampaign(db, ORG, "live", { id: C2 });
    await putAt(`${c1}renders/alpha/1x1/v1.png`, NOW - 5 * HOUR);
    await putAt(`${c2}renders/alpha/1x1/v1.png`, NOW - 5 * HOUR);
    await putAt(`${c1}renders/alpha/1x1/v2.png`, NOW - 5 * HOUR);
    await putAt(`${c1}renders/alpha/1x1/v3.png`, NOW - 5 * HOUR);

    const plan = await planReconcile(db, paged, ORG, NOW);
    expect(plan.prefixes).toEqual([{ campaignId: C1, objects: 3 }]);
    expect(plan.inputs).toEqual([]);
  });

  test("reconcile plans an orphan input found on a later page", async () => {
    const paged = new InMemoryObjectStore({ now: () => clock, listPageSize: 1 });
    async function putAt(key: string, at: number): Promise<void> {
      clock = at;
      await paged.put(key, new Uint8Array([1]));
      clock = NOW;
    }
    const campaignId = await seedCampaign(db, ORG, "live", { id: C1, tombstoned: false });
    await seedAsset(db, ORG, campaignId, A1);
    const prefix = campaignPrefix(ORG, C1);
    await putAt(`${prefix}inputs/${A1}`, NOW - 5 * HOUR);
    await putAt(`${prefix}renders/alpha/1x1/v1.png`, NOW - 5 * HOUR);
    await putAt(`${prefix}inputs/${A2}`, NOW - 5 * HOUR);

    const plan = await planReconcile(db, paged, ORG, NOW);
    expect(plan.inputs).toEqual([{ campaignId: C1, assetId: A2 }]);
  });

  test("reconcile aborts on an odd key on a later page and deletes nothing", async () => {
    const badKey = `org/local/campaign/${C1}/renders/a//b`;
    const goodKey = `${campaignPrefix(ORG, C1)}renders/good.png`;
    const stub = {
      listPages: async function* () {
        yield [{ key: goodKey, size: 1, lastModified: new Date(NOW - 5 * HOUR) }];
        yield [{ key: badKey, size: 1, lastModified: new Date(NOW - 5 * HOUR) }];
      },
      deletePrefix: vi.fn(),
      delete: vi.fn(),
    } as unknown as ObjectStorePort;
    await expect(
      reconcileOrgs(db, stub, ["local"], { apply: true, now: () => NOW }),
    ).rejects.toThrow("outside the object key alphabet");
    expect(stub.deletePrefix).not.toHaveBeenCalled();
    expect(stub.delete).not.toHaveBeenCalled();
  });

  test("reconcile reads the rows only after the last page", async () => {
    const paged = new InMemoryObjectStore({ now: () => clock, listPageSize: 1 });
    async function putAt(key: string, at: number): Promise<void> {
      clock = at;
      await paged.put(key, new Uint8Array([1]));
      clock = NOW;
    }
    const c1 = campaignPrefix(ORG, C1);
    await putAt(`${c1}inputs/${A1}`, NOW - 5 * HOUR);
    await putAt(`${c1}inputs/${A2}`, NOW - 5 * HOUR);
    await putAt(`${c1}renders/alpha/1x1/v1.png`, NOW - 5 * HOUR);

    const events: string[] = [];
    vi.spyOn(paged, "listPages").mockImplementation(async function* (
      prefix: string,
    ): AsyncGenerator<readonly ListedObject[]> {
      for await (const page of InMemoryObjectStore.prototype.listPages.call(paged, prefix)) {
        events.push("page");
        yield page;
      }
    });

    const { sql, calls } = recording(db);
    const sqlWithEvents: SqlQuery = {
      query: (text: string, params: readonly unknown[] = []) => {
        events.push("query");
        return sql.query(text, params);
      },
      exec: (text: string) => sql.exec(text),
    } as SqlQuery;

    await planReconcile(sqlWithEvents, paged, ORG, NOW);
    expect(calls.length).toBe(2);
    expect(events).toEqual(["page", "page", "page", "query", "query"]);
  });
});
