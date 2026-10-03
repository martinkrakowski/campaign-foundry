import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { resetDatabase, setDatabase } from "../../db/database.js";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import type { SqlClient } from "../../db/sql-client.js";
import { inputKey } from "../../object-store/object-keys.js";
import { ObjectAssetStore } from "../object-asset-store.js";

/**
 * `readAssetById` and `assetOwner` (PT-4k1, D208c) against a migrated database and
 * the in-memory object store. Offline end to end: no `S3_*` variable is read
 * anywhere in this file.
 *
 * Both methods are org-scoped, and the `org_id` predicate in each is the whole
 * of their tenancy — the route cannot catch a missing one, because
 * `PgBriefStore.resolveCampaign` 404s before a store is ever reached. So the
 * cross-org case is asserted HERE, against a real second org that really holds
 * the asset.
 */

const ORG = "local";
const OTHER_ORG = "other";
const SLUG = "winter-sale";
const NAME = "logo.png";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
/** A payload no other assertion in this file uses, so a leak is unmistakable. */
const THEIRS = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x7e]);

/** An id no column can hold: lower case, well formed, absent. */
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

/**
 * A client that counts every query, so "no query" is an assertion rather than an
 * inference. Wrapping rather than spying keeps the real `db` underneath: the
 * count is what is under test, not a mock's return value.
 */
function counting(db: SqlClient): SqlClient & { readonly queries: () => number } {
  let count = 0;
  return {
    ...db,
    query: (text, params) => {
      count += 1;
      return db.query(text, params);
    },
    queries: () => count,
  };
}

async function seedCampaign(db: SqlClient, orgId: string, slug: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into campaign (org_id, slug) values ($1, $2) returning id`,
    [orgId, slug],
  );
  return rows[0]!.id;
}

/** An `asset` row with no object behind it — the one absent case a `put` cannot make. */
async function seedOrphanRow(
  db: SqlClient,
  orgId: string,
  slug: string,
  name: string,
): Promise<void> {
  const campaignId = await seedCampaign(db, orgId, slug);
  await db.query(
    `insert into asset (id, org_id, campaign_id, kind, name, size, sha256, content_type)
     values ($1, $2, $3, 'input', $4, $5, $6, 'image/png')`,
    [UNKNOWN_ID, orgId, campaignId, name, PNG.length, "0".repeat(64)],
  );
}

describe("ObjectAssetStore by id (PT-4k1, D208c)", () => {
  let db: SqlClient;
  let store: InMemoryObjectStore;
  let assets: ObjectAssetStore;

  beforeEach(async () => {
    db = await migratedDatabase();
    setDatabase(db);
    store = new InMemoryObjectStore();
    assets = new ObjectAssetStore(db, store, ORG);
    await db.query(`insert into org (id, name) values ('other', 'Other')`);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resetDatabase();
    await db.end();
  });

  describe("readAssetById", () => {
    test("answers this org's own bytes for its own id", async () => {
      const campaignId = await seedCampaign(db, ORG, SLUG);
      const written = await assets.writeAsset(SLUG, NAME, PNG);
      const bytes = await assets.readAssetById(written.id!);
      expect(bytes).toBeInstanceOf(Buffer);
      expect(bytes).toEqual(PNG);
      // And it read the object the row names, under the row's own campaign —
      // which is what "the id IS the key" means, and what a lookup that rebuilt
      // the key from a slug would get wrong the moment a campaign is renamed.
      expect(await store.get(inputKey(ORG, campaignId, written.id!))).toBeDefined();
    });

    test("another org's id answers undefined and NEVER its bytes (HIGH)", async () => {
      await seedCampaign(db, ORG, SLUG);
      const theirs = new ObjectAssetStore(db, store, OTHER_ORG);
      const theirCampaignId = await seedCampaign(db, OTHER_ORG, SLUG);
      const written = await theirs.writeAsset(SLUG, NAME, THEIRS);
      // The id resolves to a REAL row with a REAL object — it exists, in another
      // tenant. Absent is the only answer this org may give it, never "forbidden"
      // (D206) and never the bytes.
      expect(await theirs.readAssetById(written.id!)).toEqual(THEIRS);
      const get = vi.spyOn(store, "get");
      expect(await assets.readAssetById(written.id!)).toBeUndefined();
      // Not merely the wrong answer: their object was never even asked for.
      expect(get).not.toHaveBeenCalled();
      // And it is still theirs afterwards.
      expect(await store.get(inputKey(OTHER_ORG, theirCampaignId, written.id!))).toBeDefined();
    });

    test("a row whose object is gone answers undefined", async () => {
      const campaignId = await seedCampaign(db, ORG, SLUG);
      const written = await assets.writeAsset(SLUG, NAME, PNG);
      await store.delete(inputKey(ORG, campaignId, written.id!));
      expect(await assets.readAssetById(written.id!)).toBeUndefined();
    });

    test("a NON-uuid answers undefined with NO query at all (C1)", async () => {
      await seedCampaign(db, ORG, SLUG);
      await assets.writeAsset(SLUG, NAME, PNG);
      const watched = counting(db);
      const guarded = new ObjectAssetStore(watched, store, ORG);
      // Three refs, each of which the `uuid` column would refuse to compare
      // against: a path, an UPPER-CASE uuid, and a near-miss of the right length.
      // Each must be answered WITHOUT a round trip — a query here raises `22P02`,
      // and this store's promise for a ref it cannot answer is `undefined`.
      for (const ref of [
        "assets/inputs/winter-sale/logo.png",
        "3F2504E0-4F89-41D3-9A0C-0305E82C3301",
        "3f2504e0-4f89-41d3-9a0c-0305e82c330",
        "",
      ]) {
        expect(await guarded.readAssetById(ref)).toBeUndefined();
      }
      expect(watched.queries()).toBe(0);
    });

    test("a store that REFUSES propagates — broken is not absent", async () => {
      await seedCampaign(db, ORG, SLUG);
      const written = await assets.writeAsset(SLUG, NAME, PNG);
      vi.spyOn(store, "get").mockRejectedValue(new Error("The object store could not be reached."));
      await expect(assets.readAssetById(written.id!)).rejects.toThrow("could not be reached");
    });
  });

  describe("assetOwner", () => {
    test("answers the campaign and the name behind this org's own id", async () => {
      const campaignId = await seedCampaign(db, ORG, SLUG);
      const written = await assets.writeAsset(SLUG, NAME, PNG);
      expect(await assets.assetOwner(written.id!)).toEqual({
        campaignId,
        slug: SLUG,
        name: NAME,
      });
    });

    test("another org's id answers undefined (HIGH)", async () => {
      await seedCampaign(db, ORG, SLUG);
      const theirs = new ObjectAssetStore(db, store, OTHER_ORG);
      await seedCampaign(db, OTHER_ORG, SLUG);
      const written = await theirs.writeAsset(SLUG, NAME, THEIRS);
      // This one leaks NOTHING rather than nothing readable: a name and a slug are
      // exactly what a caller would put in a brief, so a cross-org answer here is
      // a disclosure of another tenant's campaign structure.
      expect(await theirs.assetOwner(written.id!)).toMatchObject({ slug: SLUG, name: NAME });
      expect(await assets.assetOwner(written.id!)).toBeUndefined();
    });

    test("a NON-uuid answers undefined with NO query at all (C1)", async () => {
      await seedCampaign(db, ORG, SLUG);
      await assets.writeAsset(SLUG, NAME, PNG);
      const watched = counting(db);
      const guarded = new ObjectAssetStore(watched, store, ORG);
      for (const ref of [
        "assets/inputs/winter-sale/logo.png",
        "3F2504E0-4F89-41D3-9A0C-0305E82C3301",
        "",
      ]) {
        expect(await guarded.assetOwner(ref)).toBeUndefined();
      }
      expect(watched.queries()).toBe(0);
    });

    test("an id no row holds answers undefined", async () => {
      await seedCampaign(db, ORG, SLUG);
      expect(await assets.assetOwner(UNKNOWN_ID)).toBeUndefined();
    });

    // The brief's "the same three cases" for `assetOwner` are the three that
    // apply to it; this is the fourth, pinned because it is NOT an absent case and
    // a future "fix" would make it one. `assetOwner` asks the database, not the
    // bucket, so a row whose object was deleted still NAMES a campaign and a
    // file — and PT-4k2's save-time check needs that name to tell a deleted asset
    // from an unknown one.
    test("a row whose OBJECT is gone still answers its owner", async () => {
      const campaignId = await seedCampaign(db, ORG, SLUG);
      await assets.writeAsset(SLUG, NAME, PNG);
      const orphan = await assets.writeAsset(SLUG, "bed.mp3", PNG);
      const { rows } = await db.query<{ id: string; name: string }>(
        `select id, name from asset where campaign_id = $1`,
        [campaignId],
      );
      for (const row of rows) {
        await store.delete(inputKey(ORG, campaignId, row.id));
      }
      expect(await assets.readAssetById(orphan.id!)).toBeUndefined();
      expect(await assets.assetOwner(orphan.id!)).toEqual({
        campaignId,
        slug: SLUG,
        name: "bed.mp3",
      });
    });

    test("an ORPHAN row — inserted without an object at all — still answers its owner", async () => {
      await seedOrphanRow(db, ORG, SLUG, NAME);
      const { rows } = await db.query<{ campaign_id: string }>(
        `select campaign_id from asset where id = $1`,
        [UNKNOWN_ID],
      );
      expect(await assets.assetOwner(UNKNOWN_ID)).toEqual({
        campaignId: rows[0]!.campaign_id,
        slug: SLUG,
        name: NAME,
      });
    });
  });
});
