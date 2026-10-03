import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { hashBytes } from "../../brief-files.js";
import { resetDatabase, setDatabase } from "../../db/database.js";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import type { SqlClient } from "../../db/sql-client.js";
import { inputKey, inputPrefix } from "../../object-store/object-keys.js";
import { ObjectAssetStore } from "../object-asset-store.js";

/**
 * `copyAssets` alone (PT-4b) — the one method whose answer is consumed by
 * `rewriteAssetPaths`, so its map is a contract in itself and every branch of
 * its decision tree is driven here. Offline: a migrated database and the
 * in-memory object store, no `S3_*` anywhere.
 *
 * The rest of the adapter is in `object-asset-store.test.ts`.
 */

const ORG = "local";
const SOURCE = "winter-sale";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01]);
/** A third distinct payload, so a `-2` case is reachable without repeating one. */
const JPEG2 = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x02]);

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

async function keysUnder(
  store: InMemoryObjectStore,
  campaignId: string,
): Promise<readonly string[]> {
  return (await store.list(inputPrefix(ORG, campaignId))).map((object) => object.key).sort();
}

describe("ObjectAssetStore.copyAssets (PT-4b)", () => {
  let db: SqlClient;
  let store: InMemoryObjectStore;
  let assets: ObjectAssetStore;

  beforeEach(async () => {
    db = await migratedDatabase();
    setDatabase(db);
    store = new InMemoryObjectStore();
    assets = new ObjectAssetStore(db, store, ORG);
    await seed(db, SOURCE);
  });

  afterEach(async () => {
    resetDatabase();
    await db.end();
  });

  test("answers {} for from === to, an empty source, and either ref unresolved", async () => {
    await seed(db, "empty");
    await seed(db, "target");
    expect(await assets.copyAssets(SOURCE, SOURCE)).toEqual({});
    expect(await assets.copyAssets("empty", "target")).toEqual({});
    expect(await assets.copyAssets(SOURCE, "no-such-campaign")).toEqual({});
    expect(await assets.copyAssets("no-such-campaign", "target")).toEqual({});
    // And nothing was written for any of them.
    expect(await store.list("org/")).toEqual([]);
  });

  test("each asset lands on a NEW key and a NEW row, and the source keeps its own", async () => {
    const sourceId = (
      await db.query<{ id: string }>(`select id from campaign where org_id = $1 and slug = $2`, [
        ORG,
        SOURCE,
      ])
    ).rows[0]!.id;
    const targetId = await seed(db, "target");
    await assets.writeAsset(SOURCE, "logo.png", PNG);
    await assets.writeAsset(SOURCE, "bed.mp3", JPEG);

    expect(await assets.copyAssets(SOURCE, "target")).toEqual({
      // Both entries, always: `rewriteAssetPaths` reads either, so one of them
      // missing is how a copied brief points at a file that is not there.
      "bed.mp3": "bed.mp3",
      "logo.png": "logo.png",
      [`assets/inputs/${SOURCE}/bed.mp3`]: "assets/inputs/target/bed.mp3",
      [`assets/inputs/${SOURCE}/logo.png`]: "assets/inputs/target/logo.png",
    });

    const sourceRows = await rowsOf(db, sourceId);
    const targetRows = await rowsOf(db, targetId);
    expect(targetRows.map((row) => row.id)).not.toEqual(sourceRows.map((row) => row.id));
    expect(targetRows.map((row) => row.sha256)).toEqual([hashBytes(JPEG), hashBytes(PNG)]);
    // Every target key is built from that row's own id — a copy, never a share.
    expect(await keysUnder(store, targetId)).toEqual(
      targetRows.map((row) => inputKey(ORG, targetId, row.id)).sort(),
    );
    expect(await keysUnder(store, sourceId)).toHaveLength(2);
  });

  test("the same hash reuses the name and writes NOTHING — no second object, no second row", async () => {
    const targetId = await seed(db, "target");
    await seed(db, "twin");
    await assets.writeAsset("twin", "logo.png", PNG);
    await assets.writeAsset("target", "logo.png", PNG);
    const before = await keysUnder(store, targetId);

    expect(await assets.copyAssets("twin", "target")).toEqual({
      "logo.png": "logo.png",
      "assets/inputs/twin/logo.png": "assets/inputs/target/logo.png",
    });
    // The asset the target already has IS this asset, byte for byte. Copying it
    // again would leave an object no row could ever name.
    expect(await keysUnder(store, targetId)).toEqual(before);
    expect(await rowsOf(db, targetId)).toHaveLength(1);
  });

  test("a different hash suffixes — `-<fromSlug>`, then `-2` — and the target's own bytes stand", async () => {
    await seed(db, "target");
    await assets.writeAsset("target", "logo.png", JPEG);
    await assets.writeAsset(SOURCE, "logo.png", PNG);
    expect(await assets.copyAssets(SOURCE, "target")).toEqual({
      "logo.png": `logo-${SOURCE}.png`,
      [`assets/inputs/${SOURCE}/logo.png`]: `assets/inputs/target/logo-${SOURCE}.png`,
    });

    // The source's asset is REPLACED — how this actually happens — with bytes
    // that match NEITHER name the target now holds, so the next copy has to
    // disambiguate past what the first one took. (Replacing it with the
    // target's own bytes would take the same-hash branch instead and reuse
    // `logo.png`, which is fs's rule and is asserted above.)
    await assets.deleteAssets(SOURCE);
    await assets.writeAsset(SOURCE, "logo.png", JPEG2);
    expect(await assets.copyAssets(SOURCE, "target")).toEqual({
      "logo.png": `logo-${SOURCE}-2.png`,
      [`assets/inputs/${SOURCE}/logo.png`]: `assets/inputs/target/logo-${SOURCE}-2.png`,
    });

    expect(await assets.readAsset("target", "logo.png")).toEqual(JPEG);
    expect(await assets.readAsset("target", `logo-${SOURCE}.png`)).toEqual(PNG);
    expect(await assets.readAsset("target", `logo-${SOURCE}-2.png`)).toEqual(JPEG2);
  });

  test("a nested name keeps its directory when it is suffixed", async () => {
    // The route's `ASSET_NAME_PATTERN` admits a flat basename, so nothing it
    // writes has a directory — and a row is only ever written from a route. The
    // branch is here anyway because the alternative is SILENTLY dropping the
    // directory: `basename` alone would turn `nested/logo.png` into
    // `logo-x.png` and write the copy somewhere the map never names.
    await seed(db, "target");
    await assets.writeAsset("target", "nested/logo.png", PNG);
    await assets.writeAsset(SOURCE, "nested/logo.png", JPEG);
    expect(await assets.copyAssets(SOURCE, "target")).toEqual({
      "nested/logo.png": `nested/logo-${SOURCE}.png`,
      [`assets/inputs/${SOURCE}/nested/logo.png`]: `assets/inputs/target/nested/logo-${SOURCE}.png`,
    });
  });

  test("one campaign's deleteAssets never takes another's copy", async () => {
    const targetId = await seed(db, "target");
    await assets.writeAsset(SOURCE, "logo.png", PNG);
    await assets.copyAssets(SOURCE, "target");
    await assets.deleteAssets("target");
    expect(await keysUnder(store, targetId)).toEqual([]);
    expect(await assets.readAsset(SOURCE, "logo.png")).toEqual(PNG);
  });

  test("another org's campaign of the same slug is not a copy source", async () => {
    await db.query(`insert into org (id, name) values ('other', 'Other')`);
    const theirs = await seed(db, SOURCE, "other");
    await new ObjectAssetStore(db, store, "other").writeAsset(SOURCE, "logo.png", JPEG);
    await seed(db, "target");
    // `winter-sale` resolves in BOTH orgs, so only the org predicate decides
    // which one this is a copy of — and it is not the other tenant's.
    expect(await assets.copyAssets(SOURCE, "target")).toEqual({});
    expect((await store.list(inputPrefix("other", theirs))).map((o) => o.key)).toHaveLength(1);
  });
});
