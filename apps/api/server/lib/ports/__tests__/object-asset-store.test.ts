import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObjectExistsError } from "@campaignfoundry/CampaignOrchestration";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { resetProjectRoot } from "@campaignfoundry/shared";
import { hashBytes } from "../../brief-files.js";
import { resetDatabase, setDatabase } from "../../db/database.js";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import type { SqlClient } from "../../db/sql-client.js";
import { inputKey, inputPrefix } from "../../object-store/object-keys.js";
import {
  objectStoreClient,
  resetObjectStoreClient,
  setObjectStoreClient,
} from "../../object-store/index.js";
import { LOCAL_TENANT } from "../../tenant.js";
import { FsAssetStore } from "../fs-asset-store.js";
import { ObjectAssetStore } from "../object-asset-store.js";
import { getAssetStore, resetAssetStore } from "../index.js";

/**
 * `ObjectAssetStore` against a migrated database and the in-memory object store
 * (PT-4b). Offline end to end: no `S3_*` variable is read anywhere in this file,
 * and the store under test is the same `InMemoryObjectStore` PT-4a's
 * conformance suite holds the S3 adapter to.
 *
 * `copyAssets` has its own file — `object-asset-store-copy.test.ts`.
 */

// Slugs that are NOT substrings of the key's own literal segments: `camp` is a
// substring of `campaign`, and a "the key does not contain the slug" assertion
// against it would fail on the word `campaign` and prove nothing.
const ORG = "local";
const SLUG = "winter-sale";
const OTHER_SLUG = "summer-sale";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01]);

interface Row {
  readonly id: string;
  readonly name: string;
  readonly size: number | string;
  readonly sha256: string;
  readonly content_type: string;
}

async function rowsOf(db: SqlClient, campaignId: string): Promise<readonly Row[]> {
  const { rows } = await db.query<Row>(
    `select id, name, size, sha256, content_type from asset
      where org_id = $1 and campaign_id = $2 order by name`,
    [ORG, campaignId],
  );
  return rows;
}

async function countRows(db: SqlClient): Promise<number> {
  const { rows } = await db.query<{ n: number }>("select count(*)::int as n from asset");
  return rows[0]!.n;
}

async function seed(db: SqlClient, orgId: string, slug: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into campaign (org_id, slug) values ($1, $2) returning id`,
    [orgId, slug],
  );
  return rows[0]!.id;
}

describe("ObjectAssetStore (PT-4b)", () => {
  let db: SqlClient;
  let store: InMemoryObjectStore;
  let assets: ObjectAssetStore;
  let slugId: string;

  beforeEach(async () => {
    db = await migratedDatabase();
    setDatabase(db);
    store = new InMemoryObjectStore();
    assets = new ObjectAssetStore(db, store, ORG);
    slugId = await seed(db, ORG, SLUG);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resetDatabase();
    await db.end();
  });

  test("assetRelPath is unchanged: a brief-body path with the slug in it", () => {
    expect(assets.assetRelPath(SLUG, "logo.png")).toBe(`assets/inputs/${SLUG}/logo.png`);
  });

  describe("writeAsset", () => {
    test("stores the bytes under a key of ids, and records size, digest and type", async () => {
      expect(await assets.writeAsset(SLUG, "logo.png", PNG)).toEqual({
        path: `assets/inputs/${SLUG}/logo.png`,
        // The id is the SAME one the row holds and the key is built from (PT-4k1),
        // not merely a uuid of the right shape: it is read back through `rowsOf`
        // below and compared, so an id minted for the answer and forgotten by the
        // row would fail here rather than reach a brief.
        id: (await rowsOf(db, slugId))[0]!.id,
      });
      const rows = await rowsOf(db, slugId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        name: "logo.png",
        sha256: hashBytes(PNG),
        content_type: "image/png",
      });
      // `size` is `bigint`, and the two drivers disagree about what that means
      // in JS: `pg` hands int8 back as a STRING (int8 is outside the safe-integer
      // guarantee `pg` makes for any column) while PGlite hands back a number, so
      // a `toMatchObject` expecting `String(size)` passes on one driver and fails
      // on the other — which is CI's driver and the Mac's. The raw column is
      // therefore compared as a NUMBER: the one form both agree on, and the shape
      // `AssetEntry.size` has, so this pins what a caller reads rather than what
      // one driver happened to serialize.
      expect(Number(rows[0]!.size)).toBe(PNG.length);
      // The key is built from the row's own id and nothing else.
      expect((await store.list(inputPrefix(ORG, slugId))).map((o) => o.key)).toEqual([
        inputKey(ORG, slugId, rows[0]!.id),
      ]);
      expect(await store.get(inputKey(ORG, slugId, rows[0]!.id))).toMatchObject({
        contentType: "image/png",
      });
    });

    test("DoD 3: after a write and a copy, no key carries the slug or the name", async () => {
      await seed(db, ORG, OTHER_SLUG);
      await assets.writeAsset(SLUG, "logo.png", PNG);
      await assets.copyAssets(SLUG, OTHER_SLUG);
      const everything = await store.list("org/");
      expect(everything).toHaveLength(2);
      for (const object of everything) {
        expect(object.key).not.toContain(SLUG);
        expect(object.key).not.toContain(OTHER_SLUG);
        expect(object.key).not.toContain("logo");
      }
    });

    test("a second upload of the same name is EEXIST and leaves ONE object and ONE row", async () => {
      // The unique index IS the exclusive create, and this is the whole proof:
      // two uploads of one name mint two asset ids, so the store's own
      // `If-None-Match` passes both times and only the index can refuse. PGlite
      // attaches `code: "23505"` too, so this is the branch a real server takes.
      await assets.writeAsset(SLUG, "logo.png", PNG);
      let thrown: unknown;
      try {
        await assets.writeAsset(SLUG, "logo.png", JPEG);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as { code?: string }).code).toBe("EEXIST");
      expect((thrown as Error).message).toBe(
        `Asset "assets/inputs/${SLUG}/logo.png" already exists.`,
      );
      expect(await store.list(inputPrefix(ORG, slugId))).toHaveLength(1);
      expect(await countRows(db)).toBe(1);
      expect((await rowsOf(db, slugId))[0]).toMatchObject({ sha256: hashBytes(PNG) });
    });

    test("an insert failure after the put deletes the object and propagates", async () => {
      const failing: SqlClient = {
        ...db,
        query: async (text, params) => {
          if (text.includes("insert into asset")) throw new Error("insert exploded");
          return db.query(text, params);
        },
      };
      await expect(
        new ObjectAssetStore(failing, store, ORG).writeAsset(SLUG, "logo.png", PNG),
      ).rejects.toThrow("insert exploded");
      expect(await store.list(inputPrefix(ORG, slugId))).toEqual([]);
      expect(await countRows(db)).toBe(0);
    });

    test("a best-effort delete that ITSELF fails still propagates the original error", async () => {
      // A store that would not take the bytes also will not give them back. The
      // caller's answer is the insert's, never the cleanup's.
      const failing: SqlClient = {
        ...db,
        query: async (text, params) => {
          if (text.includes("insert into asset")) throw new Error("insert exploded");
          return db.query(text, params);
        },
      };
      vi.spyOn(store, "delete").mockRejectedValue(new Error("the store refused to forget"));
      await expect(
        new ObjectAssetStore(failing, store, ORG).writeAsset(SLUG, "logo.png", PNG),
      ).rejects.toThrow("insert exploded");
      expect(await countRows(db)).toBe(0);
    });

    test("a conditional create the STORE refuses answers the same EEXIST", async () => {
      // Defence in depth can still fire — a retry of a write that already
      // succeeded — and a caller that handles one 409 must handle the other.
      vi.spyOn(store, "put").mockRejectedValue(new ObjectExistsError("k"));
      const error = await assets.writeAsset(SLUG, "logo.png", PNG).then(
        () => undefined,
        (rejected: unknown) => rejected,
      );
      expect((error as { code?: string }).code).toBe("EEXIST");
      expect(await countRows(db)).toBe(0);
    });

    test("an unresolved slug is refused BEFORE anything is written", async () => {
      const error = await assets.writeAsset("no-such-campaign", "logo.png", PNG).then(
        () => undefined,
        (rejected: unknown) => rejected,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("does not resolve in this org");
      expect(await store.list("org/")).toEqual([]);
      expect(await countRows(db)).toBe(0);
    });

    test("a driver that puts a NUMBER on `code` is not read as a duplicate", async () => {
      // `pgErrorCode` insists on a string, and this is the case that insists: a
      // driver that attached `23505` as a number must not be taken for one that
      // attached the TEXT `23505`, or every such failure would be reported as a
      // 409 and the caller would never learn that the insert failed at all.
      const failing: SqlClient = {
        ...db,
        query: async (text, params) => {
          if (text.includes("insert into asset")) {
            throw Object.assign(new Error("insert exploded"), { code: 23505 });
          }
          return db.query(text, params);
        },
      };
      await expect(
        new ObjectAssetStore(failing, store, ORG).writeAsset(SLUG, "logo.png", PNG),
      ).rejects.toThrow("insert exploded");
      expect(await store.list(inputPrefix(ORG, slugId))).toEqual([]);
    });

    test("a store that refuses the WRITE propagates, and writes no row", async () => {
      // Distinct from the conditional-create refusal above: a transport failure
      // is not a duplicate and must not be dressed as one, and it happened
      // before any bytes were stored, so there is nothing to give back.
      vi.spyOn(store, "put").mockRejectedValue(new Error("the store was unreachable"));
      const error = await assets.writeAsset(SLUG, "logo.png", PNG).then(
        () => undefined,
        (rejected: unknown) => rejected,
      );
      expect((error as Error).message).toBe("the store was unreachable");
      expect(await countRows(db)).toBe(0);
    });
  });

  describe("readAsset", () => {
    test("answers the bytes, and undefined for every kind of absent", async () => {
      await assets.writeAsset(SLUG, "logo.png", PNG);
      expect(await assets.readAsset(SLUG, "logo.png")).toEqual(PNG);
      expect(await assets.readAsset(SLUG, "photo.jpg")).toBeUndefined(); // no row
      expect(await assets.readAsset("no-such-campaign", "logo.png")).toBeUndefined(); // no campaign
      // A row whose object is gone: the row is not the bytes.
      await store.delete(inputKey(ORG, slugId, (await rowsOf(db, slugId))[0]!.id));
      expect(await assets.readAsset(SLUG, "logo.png")).toBeUndefined();
    });

    test("a store that REFUSES propagates: broken is not absent", async () => {
      await assets.writeAsset(SLUG, "logo.png", PNG);
      vi.spyOn(store, "get").mockRejectedValue(new Error("The object store could not be reached."));
      await expect(assets.readAsset(SLUG, "logo.png")).rejects.toThrow("could not be reached");
    });
  });

  describe("assetObjectKey (PT-4f, D209b)", () => {
    test("answers the key the upload really wrote, and undefined for every absence", async () => {
      const written = await assets.writeAsset(SLUG, "logo.png", PNG);
      const [row] = await rowsOf(db, slugId);
      // The SAME key `writeAsset` built, read back through the row rather than
      // re-derived: a `?name=` redirect that pointed anywhere else would hand a
      // browser a presigned URL to an object this upload never wrote.
      expect(await assets.assetObjectKey(SLUG, "logo.png")).toBe(inputKey(ORG, slugId, row!.id));
      expect(await assets.assetObjectKey(SLUG, "photo.jpg")).toBeUndefined(); // no row
      expect(await assets.assetObjectKey("no-such-campaign", "logo.png")).toBeUndefined(); // no campaign
      // A row whose OBJECT is gone still answers its key: this method never checks
      // that the bytes are there, and the store's own 404 after the redirect is
      // what answers for it.
      await store.delete(written.id ? inputKey(ORG, slugId, written.id) : "");
      expect(await assets.assetObjectKey(SLUG, "logo.png")).toBe(inputKey(ORG, slugId, row!.id));
    });

    test("another org's SAME slug answers undefined, never that org's key", async () => {
      await assets.writeAsset(SLUG, "logo.png", PNG);
      // A real second org holding the same slug, because a slug is unique per org
      // and not globally — this is the case a missing `org_id` would leak.
      await db.query(`insert into org (id, name) values ('other', 'Other')`);
      const otherCampaign = await seed(db, "other", SLUG);
      const theirs = new ObjectAssetStore(db, store, "other");
      const theirWritten = await theirs.writeAsset(SLUG, "logo.png", JPEG);
      expect(await theirs.assetObjectKey(SLUG, "logo.png")).toBe(
        inputKey("other", otherCampaign, theirWritten.id),
      );
      // And org `local`, asking about its own slug, never sees the other's key.
      const [ourRow] = await rowsOf(db, slugId);
      expect(await assets.assetObjectKey(SLUG, "logo.png")).toBe(inputKey(ORG, slugId, ourRow!.id));
      expect(await assets.assetObjectKey(SLUG, "logo.png")).not.toBe(
        inputKey("other", otherCampaign, theirWritten.id),
      );
    });

    test("it never asks the store whether the object exists", async () => {
      await assets.writeAsset(SLUG, "logo.png", PNG);
      const get = vi.spyOn(store, "get");
      const head = vi.spyOn(store, "head");
      const list = vi.spyOn(store, "list");
      await assets.assetObjectKey(SLUG, "logo.png");
      // A `?name=` request under `s3` costs ONE query here; a HEAD round-trip would
      // double the round trips of every thumbnail in a listing for an answer the
      // browser is about to get from the store anyway.
      expect(get).not.toHaveBeenCalled();
      expect(head).not.toHaveBeenCalled();
      expect(list).not.toHaveBeenCalled();
    });
  });

  describe("listAssets", () => {
    test("answers [] for an unresolved slug and never throws for not-found", async () => {
      // `campaignKnown` in assets.get.ts depends on the empty answer.
      expect(await assets.listAssets("no-such-campaign")).toEqual([]);
    });

    test("answers rows sorted by localeCompare, with fs's exact thumbnailUrl", async () => {
      await assets.writeAsset(SLUG, "logo.png", PNG);
      await assets.writeAsset(SLUG, "bed.mp3", JPEG);
      await assets.writeAsset(SLUG, "another.png", PNG);
      // Each entry carries its own row's id (PT-4k1), read back rather than
      // pattern-matched: `rowsOf` orders by name too, so this also pins that the
      // id travels with its OWN entry — an id built from the listing's position
      // would answer the same three uuids and still be wrong for any caller that
      // stored one of them.
      const [another, bed, logo] = await rowsOf(db, slugId);
      expect(await assets.listAssets(SLUG)).toEqual([
        {
          id: another!.id,
          name: "another.png",
          type: "image/png",
          size: PNG.length,
          thumbnailUrl: `/api/pipeline/campaigns/assets?briefId=${encodeURIComponent(SLUG)}&name=another.png`,
        },
        {
          id: bed!.id,
          name: "bed.mp3",
          type: "audio/mpeg",
          size: JPEG.length,
          thumbnailUrl: `/api/pipeline/campaigns/assets?briefId=${encodeURIComponent(SLUG)}&name=bed.mp3`,
        },
        {
          id: logo!.id,
          name: "logo.png",
          type: "image/png",
          size: PNG.length,
          thumbnailUrl: `/api/pipeline/campaigns/assets?briefId=${encodeURIComponent(SLUG)}&name=logo.png`,
        },
      ]);
    });
  });

  describe("deleteAssets", () => {
    test("empties a campaign's prefix and rows by SLUG", async () => {
      const other = await seed(db, ORG, "other-campaign");
      await assets.writeAsset(SLUG, "logo.png", PNG);
      await assets.writeAsset("other-campaign", "logo.png", PNG);
      await assets.deleteAssets(SLUG);
      expect(await store.list(inputPrefix(ORG, slugId))).toEqual([]);
      expect(await rowsOf(db, slugId)).toEqual([]);
      // And only that campaign: one campaign's delete never touches another's.
      expect(await store.list(inputPrefix(ORG, other))).toHaveLength(1);
      expect(await countRows(db)).toBe(1);
    });

    test("accepts a uuid with NO lookup, which is what the create rollback needs", async () => {
      await assets.writeAsset(SLUG, "logo.png", PNG);
      // `releaseCampaign` has already removed the campaign row and the cascade
      // the asset rows with it, so a resolving lookup would no-op here.
      await db.query(`delete from campaign where id = $1`, [slugId]);
      expect(await rowsOf(db, slugId)).toEqual([]);
      await assets.deleteAssets(slugId);
      expect(await store.list(inputPrefix(ORG, slugId))).toEqual([]);
    });

    test("another org's campaign UUID deletes nothing of theirs", async () => {
      // The load-bearing half of item C4 — a uuid is used AS the campaign id with
      // no lookup — must not become a way to name another tenant's prefix. Both
      // halves of `deleteAssets` carry `org_id`, so passing a uuid this org does
      // not hold empties this org's (empty) prefix and deletes this org's (no)
      // rows, and the other org keeps every byte it had.
      await db.query(`insert into org (id, name) values ('other', 'Other')`);
      const theirId = await seed(db, "other", SLUG);
      const theirs = new ObjectAssetStore(db, store, "other");
      await theirs.writeAsset(SLUG, "logo.png", PNG);

      await assets.deleteAssets(theirId);

      // Read THEIR rows directly: `rowsOf` is org-scoped to this store's own org,
      // so asking it about another org's row would answer `[]` whether or not the
      // row survived — which is precisely the thing under test.
      const { rows } = await db.query<{ n: number }>(
        `select count(*)::int as n from asset where org_id = 'other' and campaign_id = $1`,
        [theirId],
      );
      expect(rows[0]!.n).toBe(1);
      expect(await store.list(inputPrefix("other", theirId))).toHaveLength(1);
      expect(await theirs.readAsset(SLUG, "logo.png")).toEqual(PNG);
    });

    test("an unresolved slug is a no-op, exactly as on fs", async () => {
      await assets.writeAsset(SLUG, "logo.png", PNG);
      await assets.deleteAssets("no-such-campaign");
      expect(await store.list(inputPrefix(ORG, slugId))).toHaveLength(1);
      expect(await countRows(db)).toBe(1);
    });
  });

  test("cross-tenant: another org's slug answers absent, never another org's assets", async () => {
    // The route test cannot catch this: `PgBriefStore.resolveCampaign` 404s
    // first, so the adapter's own `org_id` predicate is the only thing standing
    // between two orgs that picked the same slug — and `unique (org_id, slug)`
    // says that is a supported pair, not a mistake.
    await db.query(`insert into org (id, name) values ('other', 'Other')`);
    await seed(db, "other", SLUG);
    const theirs = new ObjectAssetStore(db, store, "other");
    await theirs.writeAsset(SLUG, "logo.png", PNG);
    await assets.writeAsset(SLUG, "logo.png", JPEG);
    // Ours alone, with OUR bytes — the other org's row and its object are both
    // under a prefix this store never asks about.
    expect(await assets.listAssets(SLUG)).toHaveLength(1);
    expect(await assets.readAsset(SLUG, "logo.png")).toEqual(JPEG);
  });
});

describe("the registry's assets slot switches on OBJECT_STORE (PT-4b)", () => {
  const SAVED = {
    OBJECT_STORE: process.env.OBJECT_STORE,
    STORE_BACKEND: process.env.STORE_BACKEND,
    PROJECT_ROOT: process.env.PROJECT_ROOT,
  };
  let db: SqlClient;
  let root: string;

  beforeEach(async () => {
    db = await migratedDatabase();
    setDatabase(db);
    root = mkdtempSync(join(tmpdir(), "cf-assets-slot-"));
    process.env.PROJECT_ROOT = root;
    process.env.STORE_BACKEND = "postgres";
    // Installed BEFORE the first `getAssetStore`, so no `S3_*` is ever read.
    setObjectStoreClient(new InMemoryObjectStore());
    resetAssetStore();
    resetProjectRoot();
  });

  afterEach(async () => {
    resetAssetStore();
    resetObjectStoreClient();
    resetDatabase();
    for (const [name, value] of Object.entries(SAVED)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
    resetProjectRoot();
    await db.end();
  });

  test("under OBJECT_STORE=s3 it builds one ObjectAssetStore per org over the object-store client", () => {
    process.env.OBJECT_STORE = "s3";
    const first = getAssetStore(LOCAL_TENANT);
    expect(first).toBeInstanceOf(ObjectAssetStore);
    expect(getAssetStore({ orgId: "local", userId: "u", roles: [], teamIds: [] })).toBe(first);
  });

  test("otherwise it is today's fs store, unchanged, and no client is ever asked for", () => {
    delete process.env.OBJECT_STORE;
    const store = getAssetStore(LOCAL_TENANT);
    expect(store).toBeInstanceOf(FsAssetStore);
    expect((store as FsAssetStore).getBaseDir()).toBe(join(root, "assets", "inputs"));
    // The object-store client is never consulted on the fs branch: this one
    // refuses outright, so a build that reached for it would throw.
    resetObjectStoreClient();
    expect(() => objectStoreClient()).toThrow('OBJECT_STORE must be "s3"');
  });
});
