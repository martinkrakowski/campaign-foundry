import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { resetDatabase, setDatabase } from "../../db/database.js";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import type { SqlClient } from "../../db/sql-client.js";
import { resetObjectStoreClient, setObjectStoreClient } from "../index.js";
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
 * that is not on this host. Without the memo, a run costs 150 GETs to draw one
 * logo 50 times.
 *
 * **What must NOT be memoised:** the refusals. A preview that ran before an
 * upload, or a re-run after one, has to see the object appear — so a failure is
 * not cached and the next read tries the store again. That is the difference
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
