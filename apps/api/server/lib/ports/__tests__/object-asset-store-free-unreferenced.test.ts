import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
  type CampaignBrief,
} from "@campaignfoundry/CampaignOrchestration";
import { resetDatabase, setDatabase } from "../../db/database.js";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import type { SqlClient } from "../../db/sql-client.js";
import { inputKey, inputPrefix } from "../../object-store/object-keys.js";
import { PgBriefStore } from "../pg-brief-store.js";
import { ObjectAssetStore } from "../object-asset-store.js";

/**
 * `freeUnreferencedAssets` on `ObjectAssetStore` (D237, PT-9e2) — the PGlite
 * provable half: row deletion guarded by `not exists` over `brief_version.body`,
 * object deletion best-effort after commit, and the `isAssetId` pre-filter that
 * skips the query entirely for non-uuid "ids".
 *
 * Offline end to end: a migrated database and the in-memory object store, no
 * `S3_*` anywhere. `TEST_PG_URL` is not branched on: PGlite is the default and
 * the suite also runs once under `env -u TEST_PG_URL` per CMDS.
 */

const ORG = "local";
const SLUG = "winter-sale";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const briefWithRef = (id: string, ref: string): CampaignBrief => ({
  schemaVersion: BRIEF_SCHEMA_VERSION,
  template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
  id,
  targetRegion: "US",
  targetAudience: "developers",
  campaignMessage: "Build great things",
  products: [
    { id: "prod-1", name: "Product 1", primaryColor: "#1473E6", logoPath: ref, inputAsset: ref },
  ],
});

interface Row {
  readonly id: string;
  readonly name: string;
  readonly size: number | string;
  readonly sha256: string;
  readonly content_type: string;
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
    `select id, name, size, sha256, content_type from asset
      where org_id = $1 and campaign_id = $2 order by name`,
    [ORG, campaignId],
  );
  return rows;
}

async function keysUnder(
  store: InMemoryObjectStore,
  campaignId: string,
): Promise<readonly string[]> {
  return (await store.list(inputPrefix(ORG, campaignId))).map((o) => o.key).sort();
}

describe("ObjectAssetStore.freeUnreferencedAssets (D237, PT-9e2)", () => {
  let db: SqlClient;
  let store: InMemoryObjectStore;
  let assets: ObjectAssetStore;

  beforeEach(async () => {
    db = await migratedDatabase();
    setDatabase(db);
    store = new InMemoryObjectStore();
    assets = new ObjectAssetStore(db, store, ORG);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resetDatabase();
    await db.end();
  });

  test("freeUnreferencedAssets frees a created id no version names", async () => {
    const campaignId = await seed(db, SLUG);
    const written = await assets.writeAsset(SLUG, "logo.png", PNG);
    const assetId = written.id!;

    // Seeding through `writeAsset` puts a row AND an object under the id — both
    // halves must be gone afterward, never just one.
    const beforeRows = await rowsOf(db, campaignId);
    expect(beforeRows).toHaveLength(1);
    expect(await keysUnder(store, campaignId)).toHaveLength(1);

    await assets.freeUnreferencedAssets(SLUG, [assetId]);

    expect(await rowsOf(db, campaignId)).toEqual([]);
    expect(await keysUnder(store, campaignId)).toEqual([]);
  });

  test("freeUnreferencedAssets keeps a created id a committed version names", async () => {
    // Pin the fixture order exactly as the row specifies: raw insert → writeAsset
    // → createBrief lands in the existing-row branch (so assertNotReserved never
    // runs) → the version that names this id is committed BEFORE the free.
    const { rows: campaigns } = await db.query<{ id: string }>(
      `insert into campaign (org_id, slug) values ('local', $1) returning id`,
      [SLUG],
    );
    const campaignId = campaigns[0]!.id;
    const written = await assets.writeAsset(SLUG, "logo.png", PNG);
    const assetId = written.id!;

    // `createBrief` with assetIds: true lands in the existing-row branch (the
    // campaign row already exists), runs assertRefsExist over the SAME id
    // writeAsset minted, and commits version 1 naming it.
    const briefs = new PgBriefStore(db, "local", "u1", [], [], true);
    await briefs.createBrief(briefWithRef(SLUG, assetId));

    await assets.freeUnreferencedAssets(SLUG, [assetId]);

    // Both the row and the object key are still present: the committed version
    // names this id, so the `not exists` guard refuses the delete.
    const afterRows = await rowsOf(db, campaignId);
    expect(afterRows).toHaveLength(1);
    expect(afterRows[0]!.id).toBe(assetId);
    expect(await keysUnder(store, campaignId)).toEqual([inputKey(ORG, campaignId, assetId)]);
  });

  test("freeUnreferencedAssets refuses an id from another campaign", async () => {
    // The `campaign_id = $1` predicate on the delete means an id passed in that
    // belongs to a DIFFERENT campaign is never touched — even though it is a real
    // row. The free is scoped to the resolved campaign, not to the id alone.
    const campaignIdA = await seed(db, SLUG);
    await seed(db, "summer-sale");
    const written = await assets.writeAsset(SLUG, "logo.png", PNG);
    const assetId = written.id!;

    await assets.freeUnreferencedAssets("summer-sale", [assetId]);

    // The asset that lives under `winter-sale` is untouched by a free aimed at
    // `summer-sale`.
    const rows = await rowsOf(db, campaignIdA);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(assetId);
    expect(await keysUnder(store, campaignIdA)).toEqual([inputKey(ORG, campaignIdA, assetId)]);
  });

  test("freeUnreferencedAssets on a tombstoned campaign frees nothing", async () => {
    // The `deleteAssets(slug)`-rule check: `select … for update where deleted_at
    // is null` returns zero rows for a tombstoned campaign, so the method
    // returns immediately — there is nothing of THIS request's left to free
    // (D237). The asset row and object survive, exactly as a fresh request's
    // first write failing would leave them.
    const campaignId = await seed(db, SLUG);
    const written = await assets.writeAsset(SLUG, "logo.png", PNG);
    const assetId = written.id!;
    await db.query(`update campaign set deleted_at = now() where id = $1`, [campaignId]);

    await assets.freeUnreferencedAssets(SLUG, [assetId]);

    expect((await rowsOf(db, campaignId)).map((r) => r.id)).toEqual([assetId]);
    expect(await keysUnder(store, campaignId)).toEqual([inputKey(ORG, campaignId, assetId)]);
  });

  test("freeUnreferencedAssets on an absent campaign frees nothing", async () => {
    const campaignId = await seed(db, SLUG);
    const written = await assets.writeAsset(SLUG, "logo.png", PNG);
    const assetId = written.id!;

    // A slug that resolves to zero rows: the method returns immediately, no
    // query against `asset` runs, and the asset is untouched.
    await assets.freeUnreferencedAssets("no-such-campaign", [assetId]);

    expect((await rowsOf(db, campaignId)).map((r) => r.id)).toEqual([assetId]);
    expect(await keysUnder(store, campaignId)).toEqual([inputKey(ORG, campaignId, assetId)]);
  });

  test("freeUnreferencedAssets with no uuid-shaped ids runs no query", async () => {
    // The `isAssetId` pre-filter is the gate, not the transaction's zero-rows
    // early return: both `[]` and a path-shaped "id" must skip the query
    // entirely, so neither `db.transaction` nor `db.query` is ever called.
    const querySpy = vi.spyOn(db, "query");
    const transactionSpy = vi.spyOn(db, "transaction");

    await assets.freeUnreferencedAssets(SLUG, []);
    await assets.freeUnreferencedAssets(SLUG, ["assets/inputs/x/logo.png"]);

    expect(querySpy).not.toHaveBeenCalled();
    expect(transactionSpy).not.toHaveBeenCalled();
  });
});
