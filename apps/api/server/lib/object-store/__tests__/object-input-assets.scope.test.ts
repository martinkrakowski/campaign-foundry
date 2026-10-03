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
 * What a ref MEANS under `s3` (PT-4d): which campaign and which asset it names,
 * and how little this port touches before it has to.
 *
 * `object-input-assets.test.ts` pins the three outcomes; this file pins the three
 * questions that decide them — which bytes a ref reaches (D206, org-scoped), what
 * `..` in a ref does, and whether an unsafe ref needs a database to be refused.
 */

const ORG = "local";
const OTHER_ORG = "other";
const SLUG = "winter-sale";
const FIRST = Buffer.from("first bytes, not an image", "utf8");
const SECOND = Buffer.from("second bytes, also not an image", "utf8");

const env = (orgId: string): RunEnvironment => ({
  tenant: { orgId, userId: "u", roles: [], teamIds: [] },
  outputRoot: "/tmp/pt-4d-output",
  assetRoot: "/tmp/pt-4d-assets",
  messageFont: "Inter",
  providers: {},
});

async function seedCampaign(db: SqlClient, orgId: string, slug: string): Promise<void> {
  // `campaign.org_id` is a foreign key, so a second org needs its own row before
  // it can hold a campaign — and holding one is the whole point of these tests.
  await db.query(`insert into org (id, name) values ($1, $1) on conflict do nothing`, [orgId]);
  await db.query(`insert into campaign (org_id, slug) values ($1, $2)`, [orgId, slug]);
}

describe("ObjectInputAssets — which object a ref reaches (PT-4d, D206)", () => {
  let db: SqlClient;
  const store = new InMemoryObjectStore();
  const SAVED_OBJECT_STORE = process.env.OBJECT_STORE;

  beforeEach(async () => {
    process.env.OBJECT_STORE = "s3";
    db = await migratedDatabase();
    setDatabase(db);
    setObjectStoreClient(store);
    resetAssetStore();
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

  /** Write one asset through PT-4b's adapter, so the rows and keys are real. */
  const write = async (orgId: string, slug: string, name: string, bytes: Buffer) => {
    await seedCampaign(db, orgId, slug);
    await new ObjectAssetStore(db, store, orgId).writeAsset(slug, name, bytes);
  };

  test("C3: `..` inside a ref reads the normalised campaign's object", async () => {
    await write(ORG, "a", "logo.png", FIRST);
    await write(ORG, "b", "logo.png", SECOND);
    // fs resolves this against the assets tree and opens campaign `b`'s file.
    // Parsing the ref BEFORE normalising would read campaign `a` instead, so a
    // brief that names a path through `..` would silently get another campaign's
    // asset — and the confinement check would be the only thing standing between
    // that and a read outside the tree.
    const bytes = await new ObjectInputAssets(env(ORG)).read("assets/inputs/a/../b/logo.png");
    expect(Buffer.from(bytes!)).toEqual(SECOND);
  });

  test("a name may carry slashes: the slug is the first segment, the name is the rest", async () => {
    await write(ORG, SLUG, "brand/logo.png", FIRST);
    const bytes = await new ObjectInputAssets(env(ORG)).read(
      `assets/inputs/${SLUG}/brand/logo.png`,
    );
    expect(Buffer.from(bytes!)).toEqual(FIRST);
  });

  // DoD 2, in the adapter's own terms: the same slug in two orgs. A slug is not
  // globally unique — the constraint is `unique (org_id, slug)` — so an unscoped
  // resolve returns SOME row, and which one is a planner's choice.
  test("cross-org: one slug in two orgs, and each ref reads its OWN org's object", async () => {
    await write(ORG, SLUG, "logo.png", FIRST);
    await write(OTHER_ORG, SLUG, "logo.png", SECOND);
    const ref = `assets/inputs/${SLUG}/logo.png`;
    expect(Buffer.from((await new ObjectInputAssets(env(ORG)).read(ref))!)).toEqual(FIRST);
    expect(Buffer.from((await new ObjectInputAssets(env(OTHER_ORG)).read(ref))!)).toEqual(SECOND);
  });

  test("cross-org: an org without the slug gets ENOENT, never the other org's bytes", async () => {
    await write(ORG, SLUG, "logo.png", FIRST);
    // A DIFFERENT slug, so the org is real and has assets of its own: the refusal
    // is about this ref, not about an org the queries know nothing of.
    await write(OTHER_ORG, "summer-sale", "logo.png", SECOND);
    await expect(
      new ObjectInputAssets(env(OTHER_ORG)).read(`assets/inputs/${SLUG}/logo.png`),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("an org with no campaigns at all gets ENOENT rather than a query failure", async () => {
    await write(ORG, SLUG, "logo.png", FIRST);
    await expect(
      new ObjectInputAssets(env("never-seen")).read(`assets/inputs/${SLUG}/logo.png`),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("ObjectInputAssets — nothing is built until a read needs it", () => {
  const SAVED_OBJECT_STORE = process.env.OBJECT_STORE;

  beforeEach(() => {
    process.env.OBJECT_STORE = "s3";
    // Deliberately NO database and NO object store client: `database()` with none
    // installed throws, and `objectStoreClient()` would read S3_* settings.
    resetDatabase();
    resetObjectStoreClient();
    resetAssetStore();
  });

  afterEach(() => {
    resetAssetStore();
    resetObjectStoreClient();
    if (SAVED_OBJECT_STORE === undefined) delete process.env.OBJECT_STORE;
    else process.env.OBJECT_STORE = SAVED_OBJECT_STORE;
  });

  test("C2: constructing it touches neither database() nor objectStoreClient()", () => {
    expect(() => new ObjectInputAssets(env(ORG), { memo: true })).not.toThrow();
  });

  test("C2: an unsafe ref answers undefined on a host with no store and no database", async () => {
    // The brief names `/etc/passwd`; refusing it has nothing to do with whether a
    // bucket is reachable, so it must not need one.
    expect(await new ObjectInputAssets(env(ORG)).read("/etc/passwd")).toBeUndefined();
  });

  test("a safe ref on that same host fails on the store, not on the ref", async () => {
    await expect(
      new ObjectInputAssets(env(ORG)).read("assets/inputs/x/logo.png"),
    ).rejects.toThrow();
  });
});
