import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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

/**
 * One row by its NAME, which is how a copy's map is checked against the asset it
 * actually made (PT-4k1). `rowsOf` orders by name and the target usually already
 * holds a row under the plain name, so picking "the first one" would name the
 * wrong asset — and a wrong id in a `toEqual` is a test that passes for the
 * wrong reason.
 */
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

  test("answers { paths: {}, created: new Set() } for from === to, an empty source, and either ref unresolved", async () => {
    await seed(db, "empty");
    await seed(db, "target");
    expect(await assets.copyAssets(SOURCE, SOURCE)).toEqual({ paths: {}, created: new Set() });
    expect(await assets.copyAssets("empty", "target")).toEqual({ paths: {}, created: new Set() });
    expect(await assets.copyAssets(SOURCE, "no-such-campaign")).toEqual({
      paths: {},
      created: new Set(),
    });
    expect(await assets.copyAssets("no-such-campaign", "target")).toEqual({
      paths: {},
      created: new Set(),
    });
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

    // Read the rows BEFORE asserting the map: under PT-4k1 the map answers in
    // IDS, so the only way to say what each entry must be is to name the row the
    // copy wrote — a shape-matched uuid here would prove nothing about whether it
    // is that row.
    const { paths: map, created } = await assets.copyAssets(SOURCE, "target");
    const sourceRows = await rowsOf(db, sourceId);
    const targetRows = await rowsOf(db, targetId);
    const [targetBed, targetLogo] = targetRows;
    const [sourceBed, sourceLogo] = sourceRows;
    expect(map).toEqual({
      // The bare name still maps to the bare name: `rewriteAssetPath`'s prefix
      // branch BUILDS `assets/inputs/<to>/<value>` from this one, and an id here
      // would make a ref nothing can read.
      "bed.mp3": "bed.mp3",
      "logo.png": "logo.png",
      // The full path maps to the target's id, and the source's own id maps to
      // that same id — one asset, two refs, both naming what the target holds.
      [`assets/inputs/${SOURCE}/bed.mp3`]: targetBed!.id,
      [`assets/inputs/${SOURCE}/logo.png`]: targetLogo!.id,
      [sourceBed!.id]: targetBed!.id,
      [sourceLogo!.id]: targetLogo!.id,
    });

    expect(targetRows.map((row) => row.id)).not.toEqual(sourceRows.map((row) => row.id));
    expect(targetRows.map((row) => row.sha256)).toEqual([hashBytes(JPEG), hashBytes(PNG)]);
    // Every target key is built from that row's own id — a copy, never a share.
    expect(await keysUnder(store, targetId)).toEqual(
      targetRows.map((row) => inputKey(ORG, targetId, row.id)).sort(),
    );
    expect(await keysUnder(store, sourceId)).toHaveLength(2);

    // Every source asset was fresh-copied: `created` has exactly as many entries
    // as sources, and each target id is in it (none are a sha-deduped reuse).
    expect(created.size).toBe(targetRows.length);
    expect(targetRows.every((row) => created.has(row.id))).toBe(true);
  });

  test("the same hash reuses the name and writes NOTHING — no second object, no second row", async () => {
    const targetId = await seed(db, "target");
    const twinId = await seed(db, "twin");
    await assets.writeAsset("twin", "logo.png", PNG);
    await assets.writeAsset("target", "logo.png", PNG);
    const before = await keysUnder(store, targetId);
    const [theirs] = await rowsOf(db, twinId);

    const { paths: map, created } = await assets.copyAssets("twin", "target");
    // The REUSED branch maps to the row the TARGET ALREADY HAS (PT-4k1), not to
    // a fresh id: there is no insert here, so a fresh id would name an object
    // nobody ever wrote — and a brief copying that name would ENOENT on its own
    // copy. Read from the target's rows, so this cannot pass on a well-shaped
    // uuid that names nothing.
    const [held] = await rowsOf(db, targetId);
    expect(map).toEqual({
      "logo.png": "logo.png",
      "assets/inputs/twin/logo.png": held!.id,
      [theirs!.id]: held!.id,
    });
    // A sha-deduped reuse writes nothing: `created` is empty and the reused id is
    // not in it (the mutation that swaps `created.add` before the reuse check
    // would put `held.id` back in — that is the case the manifest catches).
    expect(created.size).toBe(0);
    expect(created.has(held!.id)).toBe(false);
    // The asset the target already has IS this asset, byte for byte. Copying it
    // again would leave an object no row could ever name.
    expect(await keysUnder(store, targetId)).toEqual(before);
    expect(await rowsOf(db, targetId)).toHaveLength(1);
  });

  test("a different hash suffixes — `-<fromSlug>`, then `-2` — and the target's own bytes stand", async () => {
    const targetId = await seed(db, "target");
    await assets.writeAsset("target", "logo.png", JPEG);
    const original = await assets.writeAsset(SOURCE, "logo.png", PNG);

    // Each map is checked against the row that copy ACTUALLY made (PT-4k1), named
    // rather than picked by position — the target already holds a `logo.png`, and
    // `rowsOf` orders by name, so the copied row is not the first one.
    const { paths: firstMap } = await assets.copyAssets(SOURCE, "target");
    const firstCopy = await rowNamed(db, targetId, `logo-${SOURCE}.png`);
    expect(firstMap).toEqual({
      "logo.png": `logo-${SOURCE}.png`,
      [`assets/inputs/${SOURCE}/logo.png`]: firstCopy.id,
      [original.id]: firstCopy.id,
    });

    // The source's asset is REPLACED — how this actually happens — with bytes
    // that match NEITHER name the target now holds, so the next copy has to
    // disambiguate past what the first one took. (Replacing it with the
    // target's own bytes would take the same-hash branch instead and reuse
    // `logo.png`, which is fs's rule and is asserted above.)
    await assets.deleteAssets(SOURCE);
    const replacement = await assets.writeAsset(SOURCE, "logo.png", JPEG2);
    const { paths: secondMap } = await assets.copyAssets(SOURCE, "target");
    const secondCopy = await rowNamed(db, targetId, `logo-${SOURCE}-2.png`);
    expect(secondCopy.id).not.toBe(firstCopy.id);
    expect(secondMap).toEqual({
      "logo.png": `logo-${SOURCE}-2.png`,
      [`assets/inputs/${SOURCE}/logo.png`]: secondCopy.id,
      [replacement.id]: secondCopy.id,
    });

    expect(await assets.readAsset("target", "logo.png")).toEqual(JPEG);
    expect(await assets.readAsset("target", `logo-${SOURCE}.png`)).toEqual(PNG);
    expect(await assets.readAsset("target", `logo-${SOURCE}-2.png`)).toEqual(JPEG2);
  });

  test("the SAME hash under the SUFFIXED name is a no-op, not a second copy (HIGH)", async () => {
    // The case a plain re-copy cannot reach: `logo.png` is taken by different
    // bytes, so the search lands on `logo-<from>.png` — which the target ALSO
    // already holds, with the source's exact bytes, from an earlier copy. Asking
    // for a name the target already answers is not a copy: copying it anyway
    // raises a raw `23505` (a 500, not the no-op the caller asked for) and
    // leaves the copied object behind with no row naming it.
    const targetId = await seed(db, "target");
    await assets.writeAsset("target", "logo.png", JPEG);
    await assets.writeAsset("target", `logo-${SOURCE}.png`, PNG);
    const source = await assets.writeAsset(SOURCE, "logo.png", PNG);
    const before = await keysUnder(store, targetId);

    // This is the reused branch reached through a SUFFIXED name, and it maps to
    // the EXISTING row (PT-4k1) — the row an earlier copy made, named here so a
    // freshly minted id would fail rather than merely look like one.
    const held = await rowNamed(db, targetId, `logo-${SOURCE}.png`);
    const { paths: map, created } = await assets.copyAssets(SOURCE, "target");
    expect(map).toEqual({
      "logo.png": `logo-${SOURCE}.png`,
      [`assets/inputs/${SOURCE}/logo.png`]: held.id,
      [source.id]: held.id,
    });
    // Same-sha reuse through a SUFFIXED name: nothing was minted, so `created`
    // is empty and the reused id is not in it.
    expect(created.size).toBe(0);
    expect(created.has(held.id)).toBe(false);
    // The target is exactly as it was: two rows, and the same two objects.
    expect(await rowsOf(db, targetId)).toHaveLength(2);
    expect(await keysUnder(store, targetId)).toEqual(before);

    // And running it again changes nothing either — the idempotency is not a
    // one-shot courtesy to the first copy after the collision was created.
    expect((await assets.copyAssets(SOURCE, "target")).paths).toEqual(map);
    expect(await rowsOf(db, targetId)).toHaveLength(2);
    expect(await keysUnder(store, targetId)).toEqual(before);
  });

  test("an insert failure after the copy gives the object back", async () => {
    // `store.copy` runs before the insert and `briefs.post.ts` has no release
    // step, so without compensation a failed insert orphans an object under the
    // TARGET's prefix that no row will ever name and no delete will ever find.
    const targetId = await seed(db, "target");
    await assets.writeAsset(SOURCE, "logo.png", PNG);
    const failing: SqlClient = {
      ...db,
      query: async (text, params) => {
        if (text.includes("insert into asset")) throw new Error("insert exploded");
        return db.query(text, params);
      },
    };
    await expect(
      new ObjectAssetStore(failing, store, ORG).copyAssets(SOURCE, "target"),
    ).rejects.toThrow("insert exploded");
    expect(await keysUnder(store, targetId)).toEqual([]);
    expect(await rowsOf(db, targetId)).toEqual([]);
    // The SOURCE is untouched: a failed copy never takes the campaign it was
    // copying from with it.
    expect(await assets.readAsset(SOURCE, "logo.png")).toEqual(PNG);
  });

  test("a concurrent copy that took the name answers EEXIST, and frees its object", async () => {
    // The one `23505` the copy path can still see, now that every same-hash case
    // leaves before the insert. EEXIST-coded, so a caller that maps a taken name
    // to 409 maps this one too; and the object the loser copied is given back, or
    // the winner's row would be the only thing under that name.
    const targetId = await seed(db, "target");
    await assets.writeAsset(SOURCE, "logo.png", PNG);
    const racing: SqlClient = {
      ...db,
      query: async (text, params) => {
        if (text.includes("insert into asset")) {
          throw Object.assign(new Error("duplicate key"), { code: "23505" });
        }
        return db.query(text, params);
      },
    };
    const error = await new ObjectAssetStore(racing, store, ORG).copyAssets(SOURCE, "target").then(
      () => undefined,
      (rejected: unknown) => rejected,
    );
    expect((error as { code?: string }).code).toBe("EEXIST");
    expect((error as Error).message).toBe(`Asset "assets/inputs/target/logo.png" already exists.`);
    expect(await keysUnder(store, targetId)).toEqual([]);
  });

  test("a copy that WROTE the object and then rejected discards it", async () => {
    // The failure the insert-compensation cannot see: S3 commits CopyObject's
    // status line before it evaluates the copy, so `S3ObjectStore.copy` then
    // reads a success body — and a read that dies mid-stream rejects with the
    // destination object already stored. With `store.copy` outside the try, the
    // rejection escapes before the insert and nothing will ever name the object.
    const targetId = await seed(db, "target");
    await assets.writeAsset(SOURCE, "logo.png", PNG);
    const written = vi.spyOn(store, "copy").mockImplementation(async (src, dst) => {
      await InMemoryObjectStore.prototype.copy.call(store, src, dst);
      throw new Error("The object store could not be reached for copy.");
    });
    await expect(assets.copyAssets(SOURCE, "target")).rejects.toThrow(
      "could not be reached for copy",
    );
    expect(written).toHaveBeenCalledTimes(1);
    expect(await keysUnder(store, targetId)).toEqual([]);
    expect(await rowsOf(db, targetId)).toEqual([]);
  });

  test("a nested name keeps its directory when it is suffixed", async () => {
    // The route's `ASSET_NAME_PATTERN` admits a flat basename, so nothing it
    // writes has a directory — and a row is only ever written from a route. The
    // branch is here anyway because the alternative is SILENTLY dropping the
    // directory: `basename` alone would turn `nested/logo.png` into
    // `logo-x.png` and write the copy somewhere the map never names.
    const targetId = await seed(db, "target");
    await assets.writeAsset("target", "nested/logo.png", PNG);
    const source = await assets.writeAsset(SOURCE, "nested/logo.png", JPEG);
    const { paths: map } = await assets.copyAssets(SOURCE, "target");
    // Read after the copy: this is the row the copy inserted, under the SUFFIXED
    // name and inside the source's own directory — the whole of what the branch
    // this test guards is about.
    const copied = await rowNamed(db, targetId, `nested/logo-${SOURCE}.png`);
    expect(map).toEqual({
      "nested/logo.png": `nested/logo-${SOURCE}.png`,
      [`assets/inputs/${SOURCE}/nested/logo.png`]: copied.id,
      [source.id]: copied.id,
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
    expect(await assets.copyAssets(SOURCE, "target")).toEqual({ paths: {}, created: new Set() });
    expect((await store.list(inputPrefix("other", theirs))).map((o) => o.key)).toHaveLength(1);
  });

  test("copyAssets marks a fresh copy as created", async () => {
    // The two-campaigns-no-collision baseline: every asset is fresh, so `created`
    // has exactly as many entries as sources and each target id is in it.
    const targetId = await seed(db, "target");
    await assets.writeAsset(SOURCE, "logo.png", PNG);
    await assets.writeAsset(SOURCE, "bed.mp3", JPEG);

    const { paths, created } = await assets.copyAssets(SOURCE, "target");
    const targetRows = await rowsOf(db, targetId);
    expect(targetRows).toHaveLength(2);
    expect(created.size).toBe(targetRows.length);
    expect(targetRows.every((row) => created.has(row.id))).toBe(true);
    // `paths` is unchanged by this lane: still three entries per source asset.
    expect(Object.keys(paths)).toHaveLength(6);
  });

  test("copyAssets never marks a sha-deduped reuse as created", async () => {
    // A sha-deduped reuse: the target already holds the same bytes under the same
    // name, so `destination.reused` is true and the id already exists — nothing is
    // minted, so `created` is empty and the reused id is not in it.
    const targetId = await seed(db, "target");
    const twinId = await seed(db, "twin");
    await assets.writeAsset("twin", "logo.png", PNG);
    await assets.writeAsset("target", "logo.png", PNG);
    const [theirs] = await rowsOf(db, twinId);

    const { paths, created } = await assets.copyAssets("twin", "target");
    const [held] = await rowsOf(db, targetId);
    expect(paths).toEqual({
      "logo.png": "logo.png",
      "assets/inputs/twin/logo.png": held!.id,
      [theirs!.id]: held!.id,
    });
    expect(created.size).toBe(0);
    expect(created.has(held!.id)).toBe(false);
  });
});
