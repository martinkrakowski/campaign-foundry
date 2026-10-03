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
 * The per-run memo (PT-4d), opt-in through `inputAssets(env, { memo: true })` and
 * carried by the ONE instance `buildPipeline` hands to all five consumers.
 *
 * **Why it exists:** the logo is read once per cell, so a 50-cell run asks the
 * bucket for the same object about 150 times — a round trip each, to a bucket
 * that is not on this host — and cells render EIGHT AT A TIME, so the reads that
 * overlap are the common case rather than the rare one. What is memoised is
 * therefore the in-flight promise: the first cell to ask starts the fetch and the
 * other seven join it.
 *
 * **What must NOT be memoised:** the failures. A preview that ran before an
 * upload, or a re-run after one, has to see the object appear — so a rejection
 * drops the entry and the next read tries the store again. That is the difference
 * between a cache and a lie.
 */

const ORG = "local";
const SLUG = "winter-sale";
const NAME = "logo.png";
const REF = `assets/inputs/${SLUG}/${NAME}`;
const BYTES = Buffer.from("bytes of a logo, never decoded by this port", "utf8");

const env: RunEnvironment = {
  tenant: { orgId: ORG, userId: "u", roles: [], teamIds: [] },
  outputRoot: "/tmp/pt-4d-output",
  assetRoot: "/tmp/pt-4d-assets",
  messageFont: "Inter",
  providers: {},
};

/** The id the orphan row is minted under, so the object can arrive under the key it names. */
const ORPHAN_ASSET_ID = "11111111-2222-3333-4444-555555555555";

/**
 * An `asset` row with no object behind it, and the campaign it belongs to: a read
 * of that ref reaches the store and misses, which is the one absent case a `put`
 * cannot make and the only one where a second fetch is visible.
 */
async function seedOrphanRow(
  db: SqlClient,
  orgId: string,
  slug: string,
  name: string,
): Promise<string> {
  const { rows } = await db.query<{ campaign_id: string }>(
    `insert into asset (id, org_id, campaign_id, kind, name, size, sha256, content_type)
     values ($1, $2, (select id from campaign where org_id = $2 and slug = $3),
             'input', $4, 0, $5, 'image/png')
     returning campaign_id`,
    [ORPHAN_ASSET_ID, orgId, slug, name, "0".repeat(64)],
  );
  return rows[0]!.campaign_id;
}

describe("ObjectInputAssets — the per-run memo (PT-4d)", () => {
  let db: SqlClient;
  let store: InMemoryObjectStore;
  const SAVED_OBJECT_STORE = process.env.OBJECT_STORE;

  beforeEach(async () => {
    process.env.OBJECT_STORE = "s3";
    db = await migratedDatabase();
    setDatabase(db);
    store = new InMemoryObjectStore();
    setObjectStoreClient(store);
    resetAssetStore();
    await db.query(`insert into campaign (org_id, slug) values ($1, $2)`, [ORG, SLUG]);
  });

  afterEach(async () => {
    resetAssetStore();
    resetObjectStoreClient();
    resetDatabase();
    vi.restoreAllMocks();
    if (SAVED_OBJECT_STORE === undefined) delete process.env.OBJECT_STORE;
    else process.env.OBJECT_STORE = SAVED_OBJECT_STORE;
    await db.end();
  });

  test("without the flag, every read goes to the store", async () => {
    await new ObjectAssetStore(db, store, ORG).writeAsset(SLUG, NAME, BYTES);
    const get = vi.spyOn(store, "get");
    const inputs = new ObjectInputAssets(env);
    await inputs.read(REF);
    await inputs.read(REF);
    // The preview bundle's reader, and `imageGenerator`'s default: no flag, no cache.
    expect(get).toHaveBeenCalledTimes(2);
  });

  test("with the flag, a repeated read of the same ref costs ONE store get", async () => {
    await new ObjectAssetStore(db, store, ORG).writeAsset(SLUG, NAME, BYTES);
    const get = vi.spyOn(store, "get");
    const inputs = new ObjectInputAssets(env, { memo: true });
    for (let cell = 0; cell < 50; cell += 1) {
      expect(Buffer.from((await inputs.read(REF))!)).toEqual(BYTES);
    }
    expect(get).toHaveBeenCalledTimes(1);
  });

  test("a memoised read hands out its own bytes: one consumer cannot change another's", async () => {
    await new ObjectAssetStore(db, store, ORG).writeAsset(SLUG, NAME, BYTES);
    const inputs = new ObjectInputAssets(env, { memo: true });
    const first = (await inputs.read(REF))!;
    first[0] = 0;
    const second = (await inputs.read(REF))!;
    expect(Buffer.from(second)).toEqual(BYTES);
  });

  // The reason the memo holds the IN-FLIGHT promise rather than the bytes alone.
  // `GenerateCampaignUseCase` renders cells through `mapWithConcurrency` with
  // eight in flight, and every cell reads the same logo: a memo that stored bytes
  // only after the store answered let all eight open their own round trip, so the
  // expensive case was the common one and only the second run saved anything.
  test("N concurrent reads of one ref cost ONE store get, and every caller gets the bytes", async () => {
    await new ObjectAssetStore(db, store, ORG).writeAsset(SLUG, NAME, BYTES);
    const get = vi.spyOn(store, "get");
    const inputs = new ObjectInputAssets(env, { memo: true });
    const cells = await Promise.all(Array.from({ length: 24 }, () => inputs.read(REF)));
    expect(get).toHaveBeenCalledTimes(1);
    for (const bytes of cells) expect(Buffer.from(bytes!)).toEqual(BYTES);
  });

  test("a caller that JOINS an in-flight read gets its own copy of the bytes", async () => {
    // The aliasing guarantee has to hold on the join path too, not only on the
    // cached path: eight cells hold one promise's result, and a cell that wrote
    // into it would corrupt the other seven mid-composite.
    await new ObjectAssetStore(db, store, ORG).writeAsset(SLUG, NAME, BYTES);
    const inputs = new ObjectInputAssets(env, { memo: true });
    const [first, second] = await Promise.all([inputs.read(REF), inputs.read(REF)]);
    first![0] = 0;
    expect(Buffer.from(second!)).toEqual(BYTES);
    expect(first).not.toBe(second);
  });

  test("a REJECTED in-flight read is forgotten: the next read calls the store again", async () => {
    // A campaign and an asset row but NO object behind it, so the read reaches the
    // store and the `get` count below is the store's: a campaign that did not
    // resolve would never ask the store at all, and the second fetch would be
    // invisible.
    const campaignId = await seedOrphanRow(db, ORG, SLUG, NAME);
    const get = vi.spyOn(store, "get");
    const inputs = new ObjectInputAssets(env, { memo: true });
    const both = await Promise.allSettled([inputs.read(REF), inputs.read(REF)]);
    for (const outcome of both) {
      expect(outcome.status).toBe("rejected");
      expect((outcome as PromiseRejectedResult).reason).toMatchObject({ code: "ENOENT" });
    }
    // One fetch for the two concurrent callers, and the promise they shared is
    // gone: had it stayed, the object arriving below would never be looked for.
    expect(get).toHaveBeenCalledTimes(1);
    await store.put(inputKey(ORG, campaignId, ORPHAN_ASSET_ID), BYTES);
    expect(Buffer.from((await inputs.read(REF))!)).toEqual(BYTES);
    expect(get).toHaveBeenCalledTimes(2);
  });

  test("concurrent reads of DIFFERENT refs are not coalesced", async () => {
    await new ObjectAssetStore(db, store, ORG).writeAsset(SLUG, NAME, BYTES);
    await db.query(`insert into campaign (org_id, slug) values ($1, $2)`, [ORG, "summer-sale"]);
    await new ObjectAssetStore(db, store, ORG).writeAsset(
      "summer-sale",
      NAME,
      Buffer.from("the other campaign's bytes", "utf8"),
    );
    const get = vi.spyOn(store, "get");
    const inputs = new ObjectInputAssets(env, { memo: true });
    const [a, b] = await Promise.all([
      inputs.read(REF),
      inputs.read(`assets/inputs/summer-sale/${NAME}`),
    ]);
    // One fetch EACH, and each caller handed its own campaign's bytes — a memo
    // keyed on anything but the ref would answer both from one of them.
    expect(get).toHaveBeenCalledTimes(2);
    expect(Buffer.from(a!)).toEqual(BYTES);
    expect(Buffer.from(b!)).toEqual(Buffer.from("the other campaign's bytes", "utf8"));
  });

  test("a different ref is a different key — two campaigns are not confused", async () => {
    await new ObjectAssetStore(db, store, ORG).writeAsset(SLUG, NAME, BYTES);
    await db.query(`insert into campaign (org_id, slug) values ($1, $2)`, [ORG, "summer-sale"]);
    await new ObjectAssetStore(db, store, ORG).writeAsset("summer-sale", NAME, BYTES);
    const get = vi.spyOn(store, "get");
    const inputs = new ObjectInputAssets(env, { memo: true });
    await inputs.read(REF);
    await inputs.read("assets/inputs/summer-sale/logo.png");
    await inputs.read(REF);
    expect(get).toHaveBeenCalledTimes(2);
  });

  test("after a MISSING ref the next read retries the store and finds the new object", async () => {
    const inputs = new ObjectInputAssets(env, { memo: true });
    await expect(inputs.read(REF)).rejects.toMatchObject({ code: "ENOENT" });
    // The upload that a re-run is waiting on. Caching the refusal would leave the
    // run reporting a missing logo for the rest of the process's life.
    await new ObjectAssetStore(db, store, ORG).writeAsset(SLUG, NAME, BYTES);
    expect(Buffer.from((await inputs.read(REF))!)).toEqual(BYTES);
  });

  test("after a store FAILURE the next read retries the store", async () => {
    await new ObjectAssetStore(db, store, ORG).writeAsset(SLUG, NAME, BYTES);
    const get = vi.spyOn(store, "get");
    const failure = new Error("the store refused");
    get.mockRejectedValueOnce(failure);
    const inputs = new ObjectInputAssets(env, { memo: true });
    await expect(inputs.read(REF)).rejects.toBe(failure);
    expect(Buffer.from((await inputs.read(REF))!)).toEqual(BYTES);
    expect(get).toHaveBeenCalledTimes(2);
  });

  test("an unsafe ref is not cached either — it costs no store call at all", async () => {
    const inputs = new ObjectInputAssets(env, { memo: true });
    expect(await inputs.read("../escape.png")).toBeUndefined();
    expect(await inputs.read("../escape.png")).toBeUndefined();
    await expect(inputs.read(`assets/inputs/${SLUG}/${NAME}`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
