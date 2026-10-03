import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { resetDatabase, setDatabase } from "../../db/database.js";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import type { SqlClient } from "../../db/sql-client.js";
import { resetObjectStoreClient, setObjectStoreClient } from "../index.js";
import { inputKey } from "../object-keys.js";
import { ObjectInputAssets } from "../object-input-assets.js";
import { resetAssetStore } from "../../ports/index.js";
import { ObjectAssetStore } from "../../ports/object-asset-store.js";
import type { RunEnvironment } from "../../run-environment.js";

/**
 * The ID branch of `ObjectInputAssets` (PT-4k1, D208d): a stored ref that is a
 * bare lower-case uuid is read through the `asset` row it names, and it is read
 * BEFORE `resolveAssetPath` ever sees it.
 *
 * Offline, on the same harness as `object-input-assets.test.ts`: a migrated
 * database, the in-memory object store, and no `S3_*` variable read anywhere in
 * this file. The outcomes are the SAME three the path branch promises — bytes,
 * ENOENT, or a foreign failure unchanged — which is the point: a consumer must
 * not be able to tell which form a brief used.
 */

const ORG = "local";
const SLUG = "winter-sale";
const NAME = "logo.png";
/** The stored bytes, byte-compared on the way back out. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
/** Another payload, so a cross-org leak is unmistakable. */
const THEIRS = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x7e]);

const env = (orgId = ORG): RunEnvironment => ({
  tenant: { orgId, userId: "u", roles: [], teamIds: [] },
  outputRoot: "/tmp/pt-4k1-output",
  assetRoot: "/tmp/pt-4k1-assets",
  messageFont: "Inter",
  providers: {},
});

async function seedCampaign(db: SqlClient, orgId: string, slug: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into campaign (org_id, slug) values ($1, $2) returning id`,
    [orgId, slug],
  );
  return rows[0]!.id;
}

/** Seed a campaign and store one asset in it; the id it was minted under. */
async function seedAsset(
  db: SqlClient,
  store: InMemoryObjectStore,
  orgId = ORG,
  slug = SLUG,
  bytes = PNG,
): Promise<string> {
  await seedCampaign(db, orgId, slug);
  const written = await new ObjectAssetStore(db, store, orgId).writeAsset(slug, NAME, bytes);
  return written.id!;
}

/** A row with no object behind it, under an id no other helper mints. */
const ORPHAN_ASSET_ID = "11111111-2222-3333-4444-555555555555";

async function seedOrphanRow(db: SqlClient, orgId: string, slug: string): Promise<string> {
  const campaignId = await seedCampaign(db, orgId, slug);
  await db.query(
    `insert into asset (id, org_id, campaign_id, kind, name, size, sha256, content_type)
     values ($1, $2, $3, 'input', $4, $5, $6, 'image/png')`,
    [ORPHAN_ASSET_ID, orgId, campaignId, NAME, PNG.length, "0".repeat(64)],
  );
  return campaignId;
}

describe("ObjectInputAssets — the id branch (PT-4k1, D208d)", () => {
  let db: SqlClient;
  let store: InMemoryObjectStore;
  const SAVED_OBJECT_STORE = process.env.OBJECT_STORE;
  const SAVED_STORE_BACKEND = process.env.STORE_BACKEND;

  beforeEach(async () => {
    process.env.OBJECT_STORE = "s3";
    db = await migratedDatabase();
    setDatabase(db);
    store = new InMemoryObjectStore();
    setObjectStoreClient(store);
    // BEFORE the first `getAssetStore()`: the registry builds one asset store per
    // org and hands it this client, so no `S3_*` variable is ever read here.
    resetAssetStore();
  });

  afterEach(async () => {
    // Every store reset, not just the harness's — as in `object-input-assets.test.ts`:
    // `setDatabase`/`setObjectStoreClient` installed process-wide singletons this
    // test owns, and the next file's first `getAssetStore()` would be handed them.
    resetAssetStore();
    resetObjectStoreClient();
    resetDatabase();
    vi.restoreAllMocks();
    if (SAVED_OBJECT_STORE === undefined) delete process.env.OBJECT_STORE;
    else process.env.OBJECT_STORE = SAVED_OBJECT_STORE;
    if (SAVED_STORE_BACKEND === undefined) delete process.env.STORE_BACKEND;
    else process.env.STORE_BACKEND = SAVED_STORE_BACKEND;
    await db.end();
  });

  describe("the three outcomes, on an id", () => {
    test("an id reads its bytes — and that IS the proof the branch runs first", async () => {
      const id = await seedAsset(db, store);
      const bytes = await new ObjectInputAssets(env()).read(id);
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(Buffer.from(bytes!)).toEqual(PNG);
      // Before PT-4k1 this exact input answered `undefined`, and `undefined` means
      // "unsafe ref": `resolveAssetPath` refuses a bare uuid because it is not
      // under `<root>/assets`. A branch placed AFTER that check therefore reports
      // a perfectly valid asset as "is not a valid asset path", and every scene
      // and bed built from it skips or fails — with a message that blames the
      // brief for naming nothing wrong. This assertion failing is that regression.
    });

    test("another org's id rejects as ENOENT and never yields their bytes", async () => {
      await seedCampaign(db, ORG, SLUG);
      await db.query(`insert into org (id, name) values ('other', 'Other')`);
      const theirId = await seedAsset(db, store, "other", SLUG, THEIRS);
      const error = await new ObjectInputAssets(env()).read(theirId).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
      expect((error as Error).message).toContain(theirId);
      // Absent, never forbidden and never readable: the object is in the same
      // bucket, and only `org_id` in the row query stands between two tenants.
      expect(Buffer.from((await new ObjectInputAssets(env("other")).read(theirId))!)).toEqual(
        THEIRS,
      );
    });

    test("an id with a row but no object rejects as ENOENT", async () => {
      await seedOrphanRow(db, ORG, SLUG);
      const get = vi.spyOn(store, "get");
      await expect(new ObjectInputAssets(env()).read(ORPHAN_ASSET_ID)).rejects.toMatchObject({
        code: "ENOENT",
      });
      // It reached the bucket: an orphan row is the one absent case a `put` cannot
      // make, and a test that never got here would pass against a port that
      // answered ENOENT without asking.
      expect(get).toHaveBeenCalledTimes(1);
    });

    test("an id no row holds rejects as ENOENT", async () => {
      await seedCampaign(db, ORG, SLUG);
      await expect(
        new ObjectInputAssets(env()).read("00000000-0000-4000-8000-000000000000"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });

    test("a store failure rejects UNCHANGED — the same error, not wrapped", async () => {
      // Written FIRST, so the row exists: a store that refuses is a different
      // failure from an id nothing answers, and ENOENT would dress a dead bucket
      // as a missing asset.
      const id = await seedAsset(db, store);
      const refusal = new Error("the store refused");
      vi.spyOn(store, "get").mockRejectedValueOnce(refusal);
      await expect(new ObjectInputAssets(env()).read(id)).rejects.toBe(refusal);
    });

    // A ref that is NOT an id is today's path ref, unchanged: a malformed
    // uuid-LIKE string falls through to `resolveAssetPath`, which refuses it, so
    // it answers `undefined` — and specifically NOT ENOENT, because nothing was
    // asked about an asset. An UPPER-CASE uuid is the sharpest case: a
    // case-insensitive `isAssetId` would route it into the id branch and answer
    // ENOENT for a ref that was never an id.
    test.each([
      ["3F2504E0-4F89-41D3-9A0C-0305E82C3301", "an UPPER-CASE uuid"],
      ["3f2504e0-4f89-41d3-9a0c-0305e82c330", "a uuid one character short"],
      ["3f2504e0-4f89-41d3-9a0c-0305e82c3301extra", "a uuid with a suffix"],
      ["assets/inputs/winter-sale/logo.png", "a path"],
    ])("%s is still a PATH ref, so it answers undefined and never ENOENT", async (ref) => {
      await seedAsset(db, store);
      const get = vi.spyOn(store, "get");
      const answer = await new ObjectInputAssets(env())
        .read(ref)
        .then((bytes) => ({ bytes }))
        .catch((error: unknown) => ({ error }));
      // A path ref for a campaign that really holds the asset still reads.
      if (ref.startsWith("assets/")) {
        expect(Buffer.from((answer as { bytes: Uint8Array }).bytes)).toEqual(PNG);
        return;
      }
      expect((answer as { bytes?: Uint8Array }).bytes).toBeUndefined();
      expect((answer as { error?: unknown }).error).toBeUndefined();
      expect(get).not.toHaveBeenCalled();
    });
  });

  describe("the memo, on an id (PT-4k1, C5)", () => {
    test("a repeated read of one id costs ONE store get", async () => {
      const id = await seedAsset(db, store);
      const get = vi.spyOn(store, "get");
      const inputs = new ObjectInputAssets(env(), { memo: true });
      for (let cell = 0; cell < 24; cell += 1) {
        expect(Buffer.from((await inputs.read(id))!)).toEqual(PNG);
      }
      expect(get).toHaveBeenCalledTimes(1);
    });

    test("N CONCURRENT reads of one id cost ONE get, and every caller gets the bytes", async () => {
      const id = await seedAsset(db, store);
      const get = vi.spyOn(store, "get");
      const inputs = new ObjectInputAssets(env(), { memo: true });
      const cells = await Promise.all(Array.from({ length: 24 }, () => inputs.read(id)));
      // The in-flight promise, not the bytes: cells render eight at a time and all
      // of them read the same logo, so a memo that stored bytes only after the
      // bucket answered would let eight of them open their own round trip.
      expect(get).toHaveBeenCalledTimes(1);
      for (const bytes of cells) expect(Buffer.from(bytes!)).toEqual(PNG);
    });

    test("a memoised id read hands out its own bytes", async () => {
      const id = await seedAsset(db, store);
      const inputs = new ObjectInputAssets(env(), { memo: true });
      const first = (await inputs.read(id))!;
      first[0] = 0;
      expect(Buffer.from((await inputs.read(id))!)).toEqual(PNG);
    });

    test("a REJECTED id read is forgotten: the next read calls the store again", async () => {
      const campaignId = await seedOrphanRow(db, ORG, SLUG);
      const get = vi.spyOn(store, "get");
      const inputs = new ObjectInputAssets(env(), { memo: true });
      await expect(inputs.read(ORPHAN_ASSET_ID)).rejects.toMatchObject({ code: "ENOENT" });
      // The asset that had not been uploaded YET is the case that matters: a
      // cached rejection makes the run report a missing logo for the rest of the
      // process's life, and PT-4k2's save-time check would then refuse a brief
      // that the operator had just fixed. The object arrives under the row's own
      // id, which is what makes the SECOND read find it.
      await store.put(inputKey(ORG, campaignId, ORPHAN_ASSET_ID), PNG);
      expect(Buffer.from((await inputs.read(ORPHAN_ASSET_ID))!)).toEqual(PNG);
      expect(get).toHaveBeenCalledTimes(2);
    });

    test("an id ref whose store cannot even be BUILT is not cached (C5)", async () => {
      const id = await seedAsset(db, store);
      const inputs = new ObjectInputAssets(env(), { memo: true });
      // A malformed switch makes the registry throw SYNCHRONOUSLY while it builds.
      // If `getAssetStore` were moved INSIDE the id fetch, that throw would run
      // `memo.delete` before the `memo.set` it is about to reach, leaving an
      // already-rejected promise cached for the run — the exact defect the path
      // branch's ordering (f22778b5) exists to prevent, reproduced on the id one.
      process.env.OBJECT_STORE = "not-a-backend";
      resetAssetStore();
      await expect(inputs.read(id)).rejects.toThrow();
      // Configured again: the same memoised reader must reach the store, not replay
      // a rejection it cached before the promise was ever stored.
      process.env.OBJECT_STORE = "s3";
      resetAssetStore();
      const get = vi.spyOn(store, "get");
      expect(Buffer.from((await inputs.read(id))!)).toEqual(PNG);
      expect(get).toHaveBeenCalledTimes(1);
    });

    test("an id ref and a path ref for the SAME asset are memoised separately", async () => {
      const id = await seedAsset(db, store);
      const get = vi.spyOn(store, "get");
      const inputs = new ObjectInputAssets(env(), { memo: true });
      // One Map, keyed by the ref string: two refs for one asset are two entries,
      // and joining them would hand a caller a promise that says nothing about
      // which form its brief used.
      expect(Buffer.from((await inputs.read(id))!)).toEqual(PNG);
      expect(Buffer.from((await inputs.read(`assets/inputs/${SLUG}/${NAME}`))!)).toEqual(PNG);
      expect(get).toHaveBeenCalledTimes(2);
      expect(Buffer.from((await inputs.read(id))!)).toEqual(PNG);
      expect(Buffer.from((await inputs.read(`assets/inputs/${SLUG}/${NAME}`))!)).toEqual(PNG);
      expect(get).toHaveBeenCalledTimes(2);
    });
  });
});
