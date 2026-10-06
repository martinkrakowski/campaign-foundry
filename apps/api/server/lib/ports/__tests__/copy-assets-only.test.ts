import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { resetDatabase, setDatabase } from "../../db/database.js";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import type { SqlClient } from "../../db/sql-client.js";
import { inputPrefix } from "../../object-store/object-keys.js";
import { FsAssetStore } from "../fs-asset-store.js";
import { ObjectAssetStore } from "../object-asset-store.js";

/**
 * `copyAssets`'s new `only` filter (PT-9k, D238) — driven at the adapter level, so
 * each backend is exercised on its own terms. Offline: a migrated database and the
 * in-memory object store, no `S3_*` anywhere.
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

async function idOf(db: SqlClient, slug: string, orgId = ORG): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `select id from campaign where org_id = $1 and slug = $2`,
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

describe("ObjectAssetStore.copyAssets only (PT-9k, D238)", () => {
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

  test("copyAssets with only copies exactly the named rows and objects under s3", async () => {
    const sourceId = await idOf(db, SOURCE);
    const targetId = await seed(db, "target");
    await assets.writeAsset(SOURCE, "logo.png", PNG);
    await assets.writeAsset(SOURCE, "scene.png", JPEG);
    await assets.writeAsset(SOURCE, "bed.mp3", JPEG2);
    const sceneId = (await rowsOf(db, sourceId)).find((r) => r.name === "scene.png")!.id;

    const result = await assets.copyAssets(SOURCE, "target", { only: ["scene.png"] });

    // The target holds ONLY the named asset: logo and bed are filtered out before copy.
    expect((await rowsOf(db, targetId)).map((r) => r.name)).toEqual(["scene.png"]);
    expect((await keysUnder(store, targetId)).length).toBe(1);
    expect(result.created.size).toBe(1);
    // Exactly the three entries `record` makes for that one asset, and no key for
    // logo.png or bed.mp3.
    expect(Object.keys(result.paths).sort()).toEqual(
      [sceneId, "assets/inputs/winter-sale/scene.png", "scene.png"].sort(),
    );
    // The source is untouched: all three rows and three objects remain.
    expect((await rowsOf(db, sourceId)).map((r) => r.name).sort()).toEqual([
      "bed.mp3",
      "logo.png",
      "scene.png",
    ]);
    expect((await keysUnder(store, sourceId)).length).toBe(3);
  });

  test("copyAssets without only still copies the whole library under s3", async () => {
    const sourceId = await idOf(db, SOURCE);
    await assets.writeAsset(SOURCE, "logo.png", PNG);
    await assets.writeAsset(SOURCE, "scene.png", JPEG);
    await assets.writeAsset(SOURCE, "bed.mp3", JPEG2);
    const t1 = await seed(db, "target");
    const t2 = await seed(db, "target2");
    const t3 = await seed(db, "target3");

    const one = await assets.copyAssets(SOURCE, "target");
    const two = await assets.copyAssets(SOURCE, "target2", {});
    const three = await assets.copyAssets(SOURCE, "target3", { only: undefined });

    for (const [id, result] of [
      [t1, one],
      [t2, two],
      [t3, three],
    ] as const) {
      expect((await rowsOf(db, id)).map((r) => r.name).sort()).toEqual([
        "bed.mp3",
        "logo.png",
        "scene.png",
      ]);
      expect((await keysUnder(store, id)).length).toBe(3);
      expect(result.created.size).toBe(3);
    }
    // Source untouched.
    expect((await rowsOf(db, sourceId)).map((r) => r.name).sort()).toEqual([
      "bed.mp3",
      "logo.png",
      "scene.png",
    ]);
  });

  test("copyAssets with an empty only or only names the source lacks copies nothing under s3", async () => {
    const targetId = await seed(db, "target");
    const sourceId = await idOf(db, SOURCE);
    await assets.writeAsset(SOURCE, "logo.png", PNG);
    await assets.writeAsset(SOURCE, "scene.png", JPEG);

    const empty = await assets.copyAssets(SOURCE, "target", { only: [] });
    expect(empty.paths).toEqual({});
    expect(empty.created).toEqual(new Set());
    // The early return is before any insert: the target holds nothing and its prefix is empty.
    expect((await keysUnder(store, targetId)).length).toBe(0);
    expect((await rowsOf(db, targetId)).length).toBe(0);

    const nope = await assets.copyAssets(SOURCE, "target", { only: ["nope.png"] });
    expect(nope.paths).toEqual({});
    expect(nope.created).toEqual(new Set());
    expect((await rowsOf(db, targetId)).length).toBe(0);

    // The source is untouched by either request.
    expect((await rowsOf(db, sourceId)).map((r) => r.name).sort()).toEqual([
      "logo.png",
      "scene.png",
    ]);
  });
});

describe("FsAssetStore.copyAssets only (PT-9k, D238)", () => {
  let dir: string;
  let store: FsAssetStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cf-copy-only-"));
    store = new FsAssetStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("copyAssets with only copies exactly the named files including a nested one under fs", async () => {
    await store.writeAsset("camp-src", "logo.png", PNG);
    await store.writeAsset("camp-src", "bg.jpg", JPEG);
    // A nested file, written the way `fs-asset-store.test.ts` does.
    mkdirSync(join(dir, "camp-src", "sub", "dir"), { recursive: true });
    writeFileSync(join(dir, "camp-src", "sub", "dir", "nested.png"), PNG);

    const { paths, created } = await store.copyAssets("camp-src", "camp-dst", {
      only: ["logo.png", "sub/dir/nested.png"],
    });

    // Both named files are copied, including the nested one.
    expect(existsSync(join(dir, "camp-dst", "logo.png"))).toBe(true);
    expect(existsSync(join(dir, "camp-dst", "sub", "dir", "nested.png"))).toBe(true);
    // bg.jpg is filtered out before the copy loop.
    expect(existsSync(join(dir, "camp-dst", "bg.jpg"))).toBe(false);
    expect(readFileSync(join(dir, "camp-dst", "logo.png"))).toEqual(PNG);
    expect(readFileSync(join(dir, "camp-dst", "sub", "dir", "nested.png"))).toEqual(PNG);
    expect(created).toEqual(new Set(["logo.png", "sub/dir/nested.png"]));
    // Exactly the four keys fs records per asset, none for bg.jpg.
    expect(Object.keys(paths).sort()).toEqual(
      [
        "logo.png",
        "assets/inputs/camp-src/logo.png",
        "sub/dir/nested.png",
        "assets/inputs/camp-src/sub/dir/nested.png",
      ].sort(),
    );
    // The source directory still holds all three files.
    expect(existsSync(join(dir, "camp-src", "logo.png"))).toBe(true);
    expect(existsSync(join(dir, "camp-src", "bg.jpg"))).toBe(true);
    expect(existsSync(join(dir, "camp-src", "sub", "dir", "nested.png"))).toBe(true);
  });

  test("copyAssets with an empty only or only names the source lacks writes nothing under fs", async () => {
    await store.writeAsset("camp-src", "logo.png", PNG);

    const empty = await store.copyAssets("camp-src", "camp-dst", { only: [] });
    expect(empty.paths).toEqual({});
    expect(empty.created).toEqual(new Set());
    // The early return runs before mkdir: no target directory is created.
    expect(existsSync(join(dir, "camp-dst"))).toBe(false);

    const nope = await store.copyAssets("camp-src", "camp-dst", { only: ["nope.png"] });
    expect(nope.paths).toEqual({});
    expect(nope.created).toEqual(new Set());
    expect(existsSync(join(dir, "camp-dst"))).toBe(false);

    // The source is untouched.
    expect(existsSync(join(dir, "camp-src", "logo.png"))).toBe(true);
  });
});
