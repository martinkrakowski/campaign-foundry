import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
  type CampaignBrief,
} from "@campaignfoundry/CampaignOrchestration";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { hashBytes } from "../../../lib/brief-files.js";
import type { SqlClient } from "../../../lib/db/sql-client.js";
import { inputPrefix } from "../../../lib/object-store/object-keys.js";
import {
  objectStoreClient,
  resetObjectStoreClient,
  setObjectStoreClient,
} from "../../../lib/object-store/index.js";
import type { ResolvedCampaign } from "../../../lib/ports/brief-store.port.js";
import { getAssetStore, resetAssetStore } from "../../../lib/ports/index.js";
import { PgBriefStore } from "../../../lib/ports/pg-brief-store.js";
import type { TenantContext } from "../../../lib/tenant.js";
import assetsPostHandler from "../assets.post.js";
import createHandler from "../index.post.js";
import duplicateHandler from "../briefs/[id]/duplicate.post.js";
import {
  mountTenantRoute,
  setupPgHarness,
  type PgHarness,
} from "../../__tests__/tenant-harness.js";

/**
 * `POST /campaigns/assets` on Postgres (PT-4b, DoD 2), and the create
 * rollback's use of the minted campaign id.
 *
 * STATIC imports of the handlers, unlike `assets.test.ts`'s `web()` helper: that
 * one calls `vi.resetModules()` and re-imports per request, so the injected
 * database and the injected object store would never reach the route — every
 * assertion here would be about the PGlite the module rebuilt for itself. A
 * harness is set up once per test and the same instances answer every request.
 */

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const brief = (id: string): CampaignBrief => ({
  schemaVersion: BRIEF_SCHEMA_VERSION,
  template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
  id,
  targetRegion: "US",
  targetAudience: "developers",
  campaignMessage: "Build faster",
  products: [{ id: "p1", name: "P1", primaryColor: "#1473E6", logoPath: "logo.png" }],
  treatments: [{ id: "bold", layout: "headline-bottom", tone: "bold" }],
});

const local: TenantContext = { orgId: "local", userId: "u", roles: [], teamIds: ["t1"] };
const OTHER_ORG: TenantContext = { orgId: "other", userId: "u", roles: [], teamIds: [] };

async function assetCount(db: SqlClient): Promise<number> {
  const { rows } = await db.query<{ n: number }>("select count(*)::int as n from asset");
  return rows[0]!.n;
}

async function campaignIdOf(db: SqlClient, slug: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `select id from campaign where org_id = 'local' and slug = $1`,
    [slug],
  );
  return rows[0]!.id;
}

describe("POST /campaigns/assets on Postgres (PT-4b, DoD 2)", () => {
  let harness: PgHarness;
  let store: InMemoryObjectStore;
  const SAVED = process.env.OBJECT_STORE;

  beforeEach(async () => {
    process.env.OBJECT_STORE = "s3";
    harness = await setupPgHarness();
    store = new InMemoryObjectStore();
    // BEFORE the first `getAssetStore()`: the registry builds one asset store per
    // org and hands it this client, so no `S3_*` variable is ever read here.
    setObjectStoreClient(store);
    resetAssetStore();
  });

  afterEach(async () => {
    resetAssetStore();
    resetObjectStoreClient();
    vi.restoreAllMocks();
    if (SAVED === undefined) delete process.env.OBJECT_STORE;
    else process.env.OBJECT_STORE = SAVED;
    await harness.cleanup();
  });

  const post = (tenant: TenantContext, body: Record<string, unknown>) =>
    mountTenantRoute(assetsPostHandler, {
      method: "POST",
      path: "/campaigns/assets",
      tenant,
    })(
      new Request("http://x/campaigns/assets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "logo.png",
          contentBase64: PNG.toString("base64"),
          ...body,
        }),
      }),
    );

  test("another org's slug answers 404 and writes NOTHING (absent, never forbidden)", async () => {
    await harness.db.query(
      `insert into org (id, name, slug, created_at) values ('other', 'Other', 'other', now())`,
    );
    await new PgBriefStore(harness.db, "other", "u", [], []).createCampaign("theirs");

    const res = await post(local, { briefId: "theirs" });
    expect(res.status).toBe(404);
    // The IDENTICAL body a missing campaign gets: the answer never says which
    // of the two applies, or that the slug is taken elsewhere.
    expect(await res.json()).toEqual({ error: 'Campaign "theirs" not found.' });
    expect(await assetCount(harness.db)).toBe(0);
    expect(await store.list("org/")).toEqual([]);
  });

  test("a team-hidden campaign answers the IDENTICAL 404 body", async () => {
    await harness.db.query(
      `insert into team (id, name, "memberCount", org_id, created_at) values ('t2', 'Team Two', 0, 'local', now())`,
    );
    const minted = await new PgBriefStore(
      harness.db,
      "local",
      "owner",
      ["owner"],
      [],
    ).createCampaign("hidden-one", { teamId: "t2" });
    // Visible to its owner, invisible to `local` (teamIds: ["t1"]).
    expect(
      await new PgBriefStore(harness.db, "local", "owner", ["owner"], ["t2"]).resolveCampaign(
        minted.campaignId,
      ),
    ).toBeTruthy();

    const res = await post(local, { briefId: "hidden-one" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Campaign "hidden-one" not found.' });
    expect(await assetCount(harness.db)).toBe(0);
    expect(await store.list("org/")).toEqual([]);
  });

  test("a campaign the caller may see stores an asset row and one object, and a repeat is 409", async () => {
    const minted = await new PgBriefStore(harness.db, "local", "u", [], []).createCampaign("mine");
    const campaignId = await campaignIdOf(harness.db, "mine");

    const created = await post(local, { briefId: "mine" });
    expect(created.status).toBe(201);
    // The brief-body path is UNCHANGED (C4 is PT-4k's), slug and all.
    expect(await created.json()).toEqual({ path: "assets/inputs/mine/logo.png" });

    const { rows } = await harness.db.query<{ sha256: string; content_type: string }>(
      `select sha256, content_type from asset where campaign_id = $1`,
      [campaignId],
    );
    expect(rows).toEqual([{ sha256: hashBytes(PNG), content_type: "image/png" }]);

    const again = await post(local, { briefId: "mine" });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({
      error: 'Asset "assets/inputs/mine/logo.png" already exists.',
    });
    expect(await assetCount(harness.db)).toBe(1);
    expect(await store.list(inputPrefix("local", campaignId))).toHaveLength(1);
    expect(minted.campaignId).toBe(campaignId);
  });

  test("a uuid ref resolves too: the route hands the store the slug it resolved", async () => {
    const minted = await new PgBriefStore(harness.db, "local", "u", [], []).createCampaign("by-id");
    expect((await post(local, { briefId: minted.campaignId })).status).toBe(201);
    expect(await assetCount(harness.db)).toBe(1);
    // Written under the campaign's OWN prefix, which the uuid names.
    expect(await store.list(inputPrefix("local", minted.campaignId))).toHaveLength(1);
  });

  test("the client is the in-memory store the test installed, never an S3 one", () => {
    expect(objectStoreClient()).toBe(store);
    expect(getAssetStore(local)).not.toBe(store);
  });

  test("another org sees nothing of an asset it must not name", async () => {
    await harness.db.query(
      `insert into org (id, name, slug, created_at) values ('other', 'Other', 'other', now())`,
    );
    await new PgBriefStore(harness.db, "other", "u", [], []).createCampaign("theirs");
    await new PgBriefStore(harness.db, "local", "u", [], []).createCampaign("mine");
    expect((await post(local, { briefId: "mine" })).status).toBe(201);
    expect((await post(OTHER_ORG, { briefId: "mine" })).status).toBe(404);
    expect(await assetCount(harness.db)).toBe(1);
  });
});

describe("the create rollback frees the copied assets (PT-4b)", () => {
  let harness: PgHarness;
  let store: InMemoryObjectStore;
  const SAVED = process.env.OBJECT_STORE;

  beforeEach(async () => {
    process.env.OBJECT_STORE = "s3";
    harness = await setupPgHarness();
    store = new InMemoryObjectStore();
    setObjectStoreClient(store);
    resetAssetStore();
  });

  afterEach(async () => {
    resetAssetStore();
    resetObjectStoreClient();
    vi.restoreAllMocks();
    if (SAVED === undefined) delete process.env.OBJECT_STORE;
    else process.env.OBJECT_STORE = SAVED;
    await harness.cleanup();
  });

  test("a failure after the copy leaves no asset rows and no objects", async () => {
    const tenant: TenantContext = { orgId: "local", userId: "u", roles: [], teamIds: [] };
    const briefs = new PgBriefStore(harness.db, "local", "u", [], []);
    await briefs.createCampaign("source-camp");
    await briefs.createBrief(brief("source-camp"));
    // The source holds an asset, so `copyAssets` really copies one.
    await getAssetStore(tenant).writeAsset("source-camp", "logo.png", PNG);

    // `createBrief` fails AFTER the copy, which is the whole point of the order:
    // the reservation is released, and only then are the objects freed.
    const failing = vi
      .spyOn(PgBriefStore.prototype, "createBrief")
      .mockRejectedValueOnce(new Error("boom"));
    const mint = vi.spyOn(PgBriefStore.prototype, "createCampaign");

    const res = await mountTenantRoute(createHandler, {
      method: "POST",
      path: "/campaigns",
      tenant,
    })(
      new Request("http://x/campaigns", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Copy", source: "source-camp" }),
      }),
    );
    expect(res.status).toBe(500);
    expect(failing).toHaveBeenCalledTimes(1);

    // The id `createCampaign` minted, which is what `deleteAssets` was given.
    const minted = (await mint.mock.results[0]!.value) as ResolvedCampaign;
    expect(minted.slug).toBe("copy");

    // Nothing of the copy's survives: no rows of its own (the cascade took
    // them with the released campaign) and no objects under its prefix. Scoped
    // to the minted campaign, because the SOURCE's row is supposed to be here —
    // the global count is asserted next, and it is 1 for exactly that reason.
    const { rows } = await harness.db.query<{ n: number }>(
      `select count(*)::int as n from asset where campaign_id = $1`,
      [minted.campaignId],
    );
    expect(rows[0]!.n).toBe(0);
    expect(await store.list(inputPrefix("local", minted.campaignId))).toEqual([]);
    // One row left in the whole database: the SOURCE's, and its object with it.
    // A failed copy never takes the campaign it was copying from down too.
    expect(await assetCount(harness.db)).toBe(1);
    expect(await getAssetStore(tenant).readAsset("source-camp", "logo.png")).toEqual(PNG);
  });

  test("the duplicate route's rollback frees them too", async () => {
    // The identical argument, against the second route that makes the same
    // sequence. Both have a rollback that calls `deleteAssets`, and only one of
    // them was tested: a `deleteAssets(slug)` here would resolve nothing either,
    // because `releaseCampaign` above it has already deleted the campaign row
    // and the cascade the asset rows with it.
    const tenant: TenantContext = { orgId: "local", userId: "u", roles: [], teamIds: [] };
    const briefs = new PgBriefStore(harness.db, "local", "u", [], []);
    await briefs.createCampaign("source-camp");
    await briefs.createBrief(brief("source-camp"));
    await getAssetStore(tenant).writeAsset("source-camp", "logo.png", PNG);

    const failing = vi
      .spyOn(PgBriefStore.prototype, "createBrief")
      .mockRejectedValueOnce(new Error("boom"));
    const mint = vi.spyOn(PgBriefStore.prototype, "createCampaign");

    const res = await mountTenantRoute(duplicateHandler, {
      method: "POST",
      path: "/campaigns/briefs/:id/duplicate",
      tenant,
    })(
      new Request("http://x/campaigns/briefs/source-camp/duplicate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Copy" }),
      }),
    );
    expect(res.status).toBe(500);
    expect(failing).toHaveBeenCalledTimes(1);

    const minted = (await mint.mock.results[0]!.value) as ResolvedCampaign;
    expect(minted.slug).toBe("copy");

    const { rows } = await harness.db.query<{ n: number }>(
      `select count(*)::int as n from asset where campaign_id = $1`,
      [minted.campaignId],
    );
    expect(rows[0]!.n).toBe(0);
    expect(await store.list(inputPrefix("local", minted.campaignId))).toEqual([]);
    // And the source is still whole, as on the create path.
    expect(await assetCount(harness.db)).toBe(1);
    expect(await getAssetStore(tenant).readAsset("source-camp", "logo.png")).toEqual(PNG);
  });
});
