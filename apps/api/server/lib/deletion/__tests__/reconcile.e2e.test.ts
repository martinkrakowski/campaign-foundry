import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import type { SqlClient } from "../../db/sql-client.js";
import { campaignPrefix } from "../../object-store/object-keys.js";
import { ObjectAssetStore } from "../../ports/object-asset-store.js";
import { deleteCampaignRows } from "../purge-campaign.js";
import { requestCampaignDeletion } from "../request.js";
import { reconcileOrgs } from "../reconcile.js";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const ORG = "local";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("reconcile e2e (D239, real producers)", () => {
  let db: SqlClient;
  let store: InMemoryObjectStore;
  let clock: number;

  beforeEach(async () => {
    clock = NOW;
    db = await migratedDatabase();
    store = new InMemoryObjectStore({ now: () => clock });
  }, 30_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.end();
  });

  test("reconcile finds the objects a purge left behind after its rows were deleted and frees them", async () => {
    // 1. Create a live campaign
    const { rows } = await db.query<{ id: string }>(
      `insert into campaign (org_id, slug) values ('local', 'winter-sale') returning id`,
    );
    const campaignId = rows[0]!.id;

    // 2. Write an input asset through the real producer
    const assets = new ObjectAssetStore(db, store, ORG);
    const written = await assets.writeAsset("winter-sale", "logo.png", PNG);
    const assetId = written.id!;
    const objectKey = `${campaignPrefix(ORG, campaignId)}inputs/${assetId}`;

    // 3. Tombstone the campaign
    const tombstone = await requestCampaignDeletion(db, {
      orgId: ORG,
      campaignId,
      requestedBy: "t",
      mayDelete: () => true,
      graceHours: 0,
    });
    expect(tombstone.outcome).toBe("requested");

    // 4. Run step 3 of the purge (delete rows, NOT objects) — simulate a crash before step 4
    const result = await deleteCampaignRows(db, ORG, campaignId);
    expect(result).toBe("deleted");

    // Assert the campaign row and asset row are gone
    const { rows: campaignRows } = await db.query(`select 1 from campaign where id = $1::uuid`, [
      campaignId,
    ]);
    expect(campaignRows).toHaveLength(0);
    const { rows: assetRows } = await db.query(`select 1 from asset where id = $1::uuid`, [
      assetId,
    ]);
    expect(assetRows).toHaveLength(0);

    // The object is still there
    expect((await store.list(campaignPrefix(ORG, campaignId))).map((o) => o.key)).toEqual([
      objectKey,
    ]);

    // 5. At NOW: dry run plans nothing (object is fresh)
    clock = NOW;
    const dryFresh = await reconcileOrgs(db, store, [ORG], { apply: false, now: () => NOW });
    expect(dryFresh.plans[0].prefixes).toEqual([]);
    expect(dryFresh.plans[0].inputs).toEqual([]);

    // A second dry run at NOW + 2h plans exactly that prefix, store unchanged
    clock = NOW + 2 * HOUR;
    const dryOld = await reconcileOrgs(db, store, [ORG], {
      apply: false,
      now: () => NOW + 2 * HOUR,
    });
    expect(dryOld.plans[0].prefixes).toEqual([{ campaignId, objects: 1 }]);
    expect(await store.list(campaignPrefix(ORG, campaignId))).toHaveLength(1);

    // 6. Apply at NOW + 2h: the orphan prefix is deleted
    const applied = await reconcileOrgs(db, store, [ORG], {
      apply: true,
      now: () => NOW + 2 * HOUR,
    });
    expect(applied.applied.prefixes).toBe(1);
    expect(applied.applied.inputs).toBe(0);
    expect(applied.applied.skipped).toBe(0);
    expect(await store.list(campaignPrefix(ORG, campaignId))).toHaveLength(0);
  });

  test("reconcile finds the input a failed discard left behind and frees it", async () => {
    // 1. A live campaign with two real uploads
    const { rows } = await db.query<{ id: string }>(
      `insert into campaign (org_id, slug) values ($1, $2) returning id`,
      [ORG, "winter-sale"],
    );
    const campaignId = rows[0]!.id;
    const prefix = campaignPrefix(ORG, campaignId);

    const assets = new ObjectAssetStore(db, store, ORG);
    const writtenK = await assets.writeAsset("winter-sale", "logo.png", PNG);
    const kId = writtenK.id!;
    const writtenG = await assets.writeAsset("winter-sale", "bg.png", PNG);
    const gId = writtenG.id!;

    // 2. Mock the store so the discard of K fails (the row is freed, the object remains)
    vi.spyOn(store, "delete").mockRejectedValueOnce(new Error("store down"));
    await assets.freeUnreferencedAssets("winter-sale", [kId]);

    // Assert: K's row is gone, K's object remains
    const { rows: kRows } = await db.query(`select 1 from asset where id = $1::uuid`, [kId]);
    expect(kRows).toHaveLength(0);
    const kKey = `${prefix}inputs/${kId}`;
    const gKey = `${prefix}inputs/${gId}`;
    expect((await store.list(prefix)).map((o) => o.key).sort()).toEqual([gKey, kKey].sort());

    // 3. At NOW + 2h, apply: K (no asset row, old) is deleted; G (has a row) survives
    clock = NOW + 2 * HOUR;
    const applied = await reconcileOrgs(db, store, [ORG], { apply: true, now: () => clock });
    expect(applied.applied).toEqual({ prefixes: 0, inputs: 1, skipped: 0 });

    const remaining = (await store.list(prefix)).map((o) => o.key);
    expect(remaining).toEqual([gKey]);
  });
});
