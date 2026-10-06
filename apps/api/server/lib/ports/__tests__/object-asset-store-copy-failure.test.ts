import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { resetDatabase, setDatabase } from "../../db/database.js";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import type { SqlClient } from "../../db/sql-client.js";
import { inputKey, inputPrefix } from "../../object-store/object-keys.js";
import { ObjectAssetStore } from "../object-asset-store.js";

/**
 * `copyAssets` on a PARTIAL COPY FAILURE (PT-9j0): when the body throws part-way
 * through, the wrapper frees exactly what THIS call created before rethrowing
 * the original error. Offline: a migrated database and the in-memory object
 * store, no `S3_*` anywhere.
 */

const ORG = "local";
const SOURCE = "winter-sale";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01]);
const JPEG2 = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x02]);

const boom = new Error("insert exploded");

interface Row {
  readonly id: string;
  readonly name: string;
  readonly sha256: string;
}

async function seed(db: SqlClient, slug: string, orgId = ORG): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into campaign (org_id, slug) values ($1, $2) returning id`,
    [orgId, slug],
  );
  return rows[0]!.id;
}

async function rowsOf(db: SqlClient, campaignId: string): Promise<readonly Row[]> {
  const { rows } = await db.query<Row>(
    `select id, name, sha256 from asset where org_id = $1 and campaign_id = $2 order by name`,
    [ORG, campaignId],
  );
  return rows;
}

async function rowNamed(db: SqlClient, campaignId: string, name: string): Promise<Row> {
  const { rows } = await db.query<Row>(
    `select id, name, sha256 from asset
      where org_id = $1 and campaign_id = $2 and name = $3`,
    [ORG, campaignId, name],
  );
  return rows[0]!;
}

async function keysUnder(
  store: InMemoryObjectStore,
  campaignId: string,
): Promise<readonly string[]> {
  return (await store.list(inputPrefix(ORG, campaignId))).map((object) => object.key).sort();
}

function failingInsertOn(db: SqlClient, name: string): SqlClient {
  return {
    ...db,
    query: async (text, params) => {
      if (text.includes("insert into asset") && params?.[4] === name) throw boom;
      return db.query(text, params);
    },
    transaction: (work) => db.transaction(work),
  };
}

describe("ObjectAssetStore.copyAssets frees on failure (PT-9j0)", () => {
  let db: SqlClient;
  let store: InMemoryObjectStore;
  let assets: ObjectAssetStore;

  beforeEach(async () => {
    db = await migratedDatabase();
    setDatabase(db);
    store = new InMemoryObjectStore();
    assets = new ObjectAssetStore(db, store, ORG);
    await seed(db, SOURCE);
    await assets.writeAsset(SOURCE, "a.png", PNG);
    await assets.writeAsset(SOURCE, "b.png", JPEG);
    await assets.writeAsset(SOURCE, "c.png", JPEG2);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resetDatabase();
    await db.end();
  });

  test("copyAssets frees the rows and objects it created when a later asset fails and rethrows the original error", async () => {
    const targetId = await seed(db, "target");
    const failing = failingInsertOn(db, "c.png");

    const freeSpy = vi.spyOn(ObjectAssetStore.prototype, "freeUnreferencedAssets");

    await expect(
      new ObjectAssetStore(failing, store, ORG).copyAssets(SOURCE, "target"),
    ).rejects.toBe(boom);

    // The rows and objects of assets 1..N-1 are gone, and the failed asset's
    // object was already discarded by the body.
    expect(await rowsOf(db, targetId)).toEqual([]);
    expect(await keysUnder(store, targetId)).toEqual([]);

    // The SOURCE is untouched.
    const sourceId = (
      await db.query<{ id: string }>(`select id from campaign where org_id = $1 and slug = $2`, [
        ORG,
        SOURCE,
      ])
    ).rows[0]!.id;
    expect(await rowsOf(db, sourceId)).toHaveLength(3);
    expect(await keysUnder(store, sourceId)).toHaveLength(3);

    // The wrapper freed exactly what the call created (three ids: a, b, c),
    // and only once.
    expect(freeSpy).toHaveBeenCalledTimes(1);
    expect(freeSpy).toHaveBeenCalledWith("target", expect.arrayContaining([expect.any(String)]));
    expect(freeSpy.mock.calls[0]![1]).toHaveLength(3);
  });

  test("copyAssets never frees a reused target row when a later asset fails", async () => {
    const targetId = await seed(db, "target");
    // The target already holds a.png = PNG, the SAME bytes as the source's, so the
    // copy REUSES it. Also give the target an UNRELATED asset under a name the source
    // does not carry.
    await assets.writeAsset("target", "a.png", PNG);
    await assets.writeAsset("target", "mine.png", JPEG2);
    const held = await rowNamed(db, targetId, "a.png");
    const heldKey = inputKey(ORG, targetId, held.id);
    const mine = await rowNamed(db, targetId, "mine.png");
    const mineKey = inputKey(ORG, targetId, mine.id);
    // Read BOTH pre-existing rows (id and key) before the copy.
    expect(await keysUnder(store, targetId)).toEqual([heldKey, mineKey].sort());

    const failing = failingInsertOn(db, "c.png");
    const freeSpy = vi.spyOn(ObjectAssetStore.prototype, "freeUnreferencedAssets");

    await expect(
      new ObjectAssetStore(failing, store, ORG).copyAssets(SOURCE, "target"),
    ).rejects.toBe(boom);

    // The target's rows are exactly the two original rows (same ids, length 2),
    // both object keys are still present under the target prefix and no other key
    // is, and the free spy's ids contain neither of the two ids.
    const after = await rowsOf(db, targetId);
    expect(after).toHaveLength(2);
    expect(after.map((r) => r.id).sort()).toEqual([held.id, mine.id].sort());
    expect(await keysUnder(store, targetId)).toEqual([heldKey, mineKey].sort());

    const freeIds = freeSpy.mock.calls[0]![1] as string[];
    expect(freeIds).not.toContain(held.id);
    expect(freeIds).not.toContain(mine.id);
  });

  test("copyAssets rethrows the original error when its own free also fails", async () => {
    const targetId = await seed(db, "target");
    const failing = failingInsertOn(db, "c.png");
    const freeSpy = vi
      .spyOn(ObjectAssetStore.prototype, "freeUnreferencedAssets")
      .mockRejectedValueOnce(new Error("free failed"));

    const result = new ObjectAssetStore(failing, store, ORG).copyAssets(SOURCE, "target");

    await expect(result).rejects.toThrow("insert exploded");
    // The free spy was called exactly once and it rejected.
    expect(freeSpy).toHaveBeenCalledTimes(1);
    // The error is the ORIGINAL insert error, not the free error.
    try {
      await result;
    } catch (error) {
      expect(error).toBe(boom);
      expect((error as Error).message).not.toContain("free failed");
    }

    // STATE: the rows of a.png and b.png are still in the target (the leftover
    // the release cascade and D239 take: pin it so a future change is a decision).
    const after = await rowsOf(db, targetId);
    expect(after).toHaveLength(2);
    expect(after.map((r) => r.name)).toEqual(["a.png", "b.png"]);
  });

  test("copyAssets with a failing first asset leaves the target as it was", async () => {
    const targetId = await seed(db, "target");
    const failing = failingInsertOn(db, "a.png");
    const freeSpy = vi.spyOn(ObjectAssetStore.prototype, "freeUnreferencedAssets");

    await expect(
      new ObjectAssetStore(failing, store, ORG).copyAssets(SOURCE, "target"),
    ).rejects.toBe(boom);

    // The target was empty and the first asset failed, so nothing was created —
    // the rows and objects of the target are [].
    expect(await rowsOf(db, targetId)).toEqual([]);
    expect(await keysUnder(store, targetId)).toEqual([]);

    // The source is untouched.
    const sourceId = (
      await db.query<{ id: string }>(`select id from campaign where org_id = $1 and slug = $2`, [
        ORG,
        SOURCE,
      ])
    ).rows[0]!.id;
    expect(await rowsOf(db, sourceId)).toHaveLength(3);
    expect(await keysUnder(store, sourceId)).toHaveLength(3);

    // The free spy was called exactly once with ("target", [<one uuid>]) — the
    // failed id, which matches no row.
    expect(freeSpy).toHaveBeenCalledTimes(1);
    const freeIds = freeSpy.mock.calls[0]![1] as string[];
    expect(freeIds).toHaveLength(1);
    expect(freeSpy.mock.calls[0]![0]).toBe("target");
  });

  test("copyAssets returns its map and frees nothing when every asset copies", async () => {
    const targetId = await seed(db, "target");
    const freeSpy = vi.spyOn(ObjectAssetStore.prototype, "freeUnreferencedAssets");

    const { paths, created } = await assets.copyAssets(SOURCE, "target");

    // `paths` has 3 entries per asset: the bare name, the `assets/inputs/<source>/<name>`
    // path, and the source id → target id mapping.
    expect(Object.keys(paths).filter((k) => k.includes("assets/inputs/"))).toHaveLength(3);
    expect(
      Object.keys(paths)
        .filter((k) => k.includes("assets/inputs/"))
        .every((k) => paths[k]!),
    ).toBe(true);
    // `created` has three entries.
    expect(created.size).toBe(3);

    // Three rows and three objects in the target.
    expect(await rowsOf(db, targetId)).toHaveLength(3);
    expect(await keysUnder(store, targetId)).toHaveLength(3);

    // The free spy was NEVER called.
    expect(freeSpy).not.toHaveBeenCalled();
  });
});
