import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { resetDatabase, setDatabase } from "../../db/database.js";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import type { SqlClient } from "../../db/sql-client.js";
import { resetObjectStoreClient, setObjectStoreClient } from "../index.js";
import { ObjectInputAssets } from "../object-input-assets.js";
import { S3ObjectStore, S3RequestError } from "../S3ObjectStore.js";
import { resetAssetStore } from "../../ports/index.js";
import { ObjectAssetStore } from "../../ports/object-asset-store.js";
import type { RunEnvironment } from "../../run-environment.js";

/**
 * `ObjectInputAssets` offline (PT-4d): a migrated database, the in-memory object
 * store, and no `S3_*` variable read anywhere in this file — the same harness
 * `object-asset-store.test.ts` uses, because the store under test is the same
 * `ObjectAssetStore` this port reads THROUGH.
 *
 * The three outcomes are the whole contract (every consumer's failure policy is
 * written against them), so each is pinned separately: `undefined` for a refused
 * ref, ENOENT for a safe ref nothing answers, and a foreign failure unchanged.
 */

const ORG = "local";
const SLUG = "winter-sale";
const NAME = "logo.png";
const REF = `assets/inputs/${SLUG}/${NAME}`;
/** The stored bytes, byte-compared on the way back out. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** A store whose every `get` throws — the "bucket cannot be read" case. */
class RefusingStore extends InMemoryObjectStore {
  constructor(private readonly error: Error) {
    super();
  }
  override async get(): Promise<never> {
    throw this.error;
  }
}

const env = (orgId = ORG): RunEnvironment => ({
  tenant: { orgId, userId: "u", roles: [], teamIds: [] },
  outputRoot: "/tmp/pt-4d-output",
  assetRoot: "/tmp/pt-4d-assets",
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

/** An `asset` row with no object behind it — the one absent case a put cannot make. */
async function seedOrphanRow(db: SqlClient, orgId: string, slug: string, name: string) {
  const campaignId = await seedCampaign(db, orgId, slug);
  await db.query(
    `insert into asset (id, org_id, campaign_id, kind, name, size, sha256, content_type)
     values ($1, $2, $3, 'input', $4, $5, $6, 'image/png')`,
    ["11111111-2222-3333-4444-555555555555", orgId, campaignId, name, PNG.length, "0".repeat(64)],
  );
}

describe("ObjectInputAssets (PT-4d)", () => {
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
    // org and hands it this client, so no `S3_*` variable is ever read.
    resetAssetStore();
  });

  afterEach(async () => {
    // Every store reset, not just the harness's: `setDatabase`/`setObjectStoreClient`
    // installed process-wide singletons this test owns, and the next file's first
    // `getAssetStore()` would otherwise be handed them.
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

  /** Seed a campaign and store one asset in it through PT-4b's adapter. */
  const seed = async (slug = SLUG, bytes = PNG, name = NAME) => {
    await seedCampaign(db, ORG, slug);
    await new ObjectAssetStore(db, store, ORG).writeAsset(slug, name, bytes);
  };

  describe("the three outcomes", () => {
    test("an unsafe ref answers undefined, for exactly what resolveAssetPath refuses", async () => {
      const inputs = new ObjectInputAssets(env());
      for (const ref of [
        "",
        "/etc/passwd",
        "../outside.png",
        "assets",
        "assets/../secret.png",
        "briefs/campaign.json",
      ]) {
        expect(await inputs.read(ref)).toBeUndefined();
      }
    });

    test("a safe ref with no campaign row rejects as ENOENT", async () => {
      const inputs = new ObjectInputAssets(env());
      const error = await inputs.read(REF).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
      expect((error as Error).message).toContain(REF);
    });

    test("a safe ref with a campaign but no asset row rejects as ENOENT", async () => {
      await seedCampaign(db, ORG, SLUG);
      const inputs = new ObjectInputAssets(env());
      await expect(inputs.read(REF)).rejects.toMatchObject({ code: "ENOENT" });
    });

    test("a safe ref with a row but no object rejects as ENOENT", async () => {
      await seedOrphanRow(db, ORG, SLUG, NAME);
      const inputs = new ObjectInputAssets(env());
      await expect(inputs.read(REF)).rejects.toMatchObject({ code: "ENOENT" });
    });

    // C8: the repo ships `assets/inputs/hydra-logo.png`, and under fs it resolves.
    // There is no campaign to read it through under s3, so it is a MISSING asset
    // — ENOENT, never `undefined`, and never a special case that falls back to disk.
    test("a root-level demo ref with no slug rejects as ENOENT, without asking the store", async () => {
      await seedCampaign(db, ORG, SLUG);
      const get = vi.spyOn(store, "get");
      const inputs = new ObjectInputAssets(env());
      await expect(inputs.read("assets/inputs/hydra-logo.png")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(get).not.toHaveBeenCalled();
    });

    test("a ref outside inputs/ rejects as ENOENT — no object can answer one", async () => {
      await seedCampaign(db, ORG, SLUG);
      const inputs = new ObjectInputAssets(env());
      await expect(inputs.read("assets/other/logo.png")).rejects.toMatchObject({
        code: "ENOENT",
      });
    });

    // The three shapes `path.resolve` flattens before the ref reaches the parser:
    // an empty campaign segment, a doubled separator and a trailing one. Under fs
    // each is a different file that happens not to exist; under s3 each names no
    // campaign at all, and every one of them must land on ENOENT — never on
    // `undefined`, which would report a safe ref as unsafe and blame the brief.
    test.each([
      "assets/inputs//logo.png",
      "assets/inputs/winter-sale/",
      "assets/inputs/winter-sale//logo.png",
    ])("%s rejects as ENOENT, never as an unsafe ref", async (ref) => {
      await seedCampaign(db, ORG, SLUG);
      await expect(new ObjectInputAssets(env()).read(ref)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });

    test("a store failure rejects UNCHANGED — the same error, not wrapped", async () => {
      // Written FIRST, so the row exists: a store that refuses is a different
      // failure from a ref nothing answers, and a test that never reaches `get`
      // would pass against a port that mapped every refusal to ENOENT.
      await seed();
      const refusal = new S3RequestError("get", 500);
      resetAssetStore();
      setObjectStoreClient(new RefusingStore(refusal));
      const inputs = new ObjectInputAssets(env());
      await expect(inputs.read(REF)).rejects.toBe(refusal);
    });

    test("an unreachable endpoint rejects non-ENOENT (status 0), offline", async () => {
      await seed();
      resetAssetStore();
      setObjectStoreClient(
        new S3ObjectStore({
          settings: {
            // Port 1 is closed: the transport fails before a request is sent, which
            // is what makes this case offline.
            endpoint: "http://127.0.0.1:1",
            publicEndpoint: "http://127.0.0.1:1",
            region: "us-east-1",
            bucket: "in-memory",
            accessKeyId: "key",
            secretAccessKey: "secret",
          },
        }),
      );
      const error = await new ObjectInputAssets(env()).read(REF).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(S3RequestError);
      expect((error as S3RequestError).status).toBe(0);
    });

    test("a successful read answers the exact bytes that were stored", async () => {
      await seed();
      const bytes = await new ObjectInputAssets(env()).read(REF);
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(Buffer.from(bytes!)).toEqual(PNG);
    });
  });
});
