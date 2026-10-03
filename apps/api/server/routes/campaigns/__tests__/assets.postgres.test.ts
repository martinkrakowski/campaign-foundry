import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
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
import { ObjectAssetStore } from "../../../lib/ports/object-asset-store.js";
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
 * `POST /campaigns/assets` on Postgres (PT-4b, DoD 2), and the two routes whose
 * rollback frees a failed copy's assets.
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
    // the copied assets are freed, and only then is the reservation released.
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

    // The uuid `createCampaign` minted, which is the campaign whose prefix the
    // copy wrote under — not, any more, what `deleteAssets` is given.
    const minted = (await mint.mock.results[0]!.value) as ResolvedCampaign;
    expect(minted.slug).toBe("copy");

    // Nothing of the copy's survives: `deleteAssets(<slug>)` resolved the slug to
    // that uuid while the row still existed, so it removed the rows AND the
    // objects. Scoped to the minted campaign, because the SOURCE's row is
    // supposed to be here — the global count is asserted next, and it is 1 for
    // exactly that reason.
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
    // sequence: mint, copy, check, free, release. Both have a rollback, and only
    // one of them was tested — which is how a fix lands on one of two identical
    // sites.
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

  test("a cleanup failure still releases the campaign, and the ORIGINAL error is what surfaces", async () => {
    // The free is best-effort because the RELEASE is what makes the campaign go
    // away: skipping it instead would strand a versionless reservation, and its
    // assets, for good. So a store that refuses to free must not stop the
    // release — and must not become the error the caller hears either. EEXIST is
    // the shape that tells them apart: this route maps it to 409 carrying ITS
    // OWN message, so a 409 whose body names the cleanup would mean the wrong
    // error won.
    const tenant: TenantContext = { orgId: "local", userId: "u", roles: [], teamIds: [] };
    const briefs = new PgBriefStore(harness.db, "local", "u", [], []);
    await briefs.createCampaign("source-camp");
    await briefs.createBrief(brief("source-camp"));
    await getAssetStore(tenant).writeAsset("source-camp", "logo.png", PNG);

    const real = Object.assign(new Error("the real failure"), { code: "EEXIST" });
    vi.spyOn(PgBriefStore.prototype, "createBrief").mockRejectedValueOnce(real);
    vi.spyOn(ObjectAssetStore.prototype, "deleteAssets").mockRejectedValue(
      new Error("the cleanup exploded"),
    );

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
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "the real failure" });
    // The release ran, so the reservation is gone — that is the thing the
    // best-effort free exists to protect.
    const { rows: left } = await harness.db.query<{ n: number }>(
      `select count(*)::int as n from campaign where org_id = 'local' and slug = 'copy'`,
    );
    expect(left[0]!.n).toBe(0);
  });

  describe("with a SECOND instance winning the slug (fix round 3, MEDIUM)", () => {
    // The race both routes' docstrings name. `withBriefLock` is IN-PROCESS
    // (`pg-brief-store.ts`: a map of promise chains on this process), so on
    // Postgres a second API instance can write version 1 under the target slug
    // between this request's `createCampaign` and its `createBrief`. That
    // campaign is a REAL one the moment its first version exists — and an
    // unconditional free empties its assets while the release, correctly,
    // refuses to remove it. Data loss, not a leak.
    const tenant: TenantContext = { orgId: "local", userId: "u", roles: [], teamIds: [] };

    beforeEach(async () => {
      const briefs = new PgBriefStore(harness.db, "local", "u", [], []);
      await briefs.createCampaign("source-camp");
      await briefs.createBrief(brief("source-camp"));
      await getAssetStore(tenant).writeAsset("source-camp", "logo.png", PNG);
    });

    /**
     * Make `createBrief` behave like a losing writer against a campaign another
     * instance has just finished: write version 1 FIRST, through a store of its
     * own, then raise the EEXIST a conflict answers with.
     *
     * The captured original matters: the spy is on `PgBriefStore.prototype`, so
     * a second INSTANCE would be intercepted too and the winner's version would
     * never be written. Calling the original on the other instance is what makes
     * this a different actor's write rather than this request's own retry.
     */
    function competingWriter(): ReturnType<typeof vi.spyOn> {
      const real = PgBriefStore.prototype.createBrief;
      return vi.spyOn(PgBriefStore.prototype, "createBrief").mockImplementationOnce(async function (
        this: PgBriefStore,
        body,
        options,
      ) {
        const other = new PgBriefStore(harness.db, "local", "other-instance", [], []);
        await real.call(other, body, options);
        throw Object.assign(new Error(`Brief "${body.id}" already exists.`), { code: "EEXIST" });
      });
    }

    const createCall = () =>
      mountTenantRoute(createHandler, { method: "POST", path: "/campaigns", tenant })(
        new Request("http://x/campaigns", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Copy", source: "source-camp" }),
        }),
      );

    const duplicateCall = () =>
      mountTenantRoute(duplicateHandler, {
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

    /** The winner's campaign, and the asset the copy put into it. */
    async function won(): Promise<{ campaignId: string; rows: number; objects: number }> {
      const { rows: campaigns } = await harness.db.query<{ id: string }>(
        `select id from campaign where org_id = 'local' and slug = 'copy'`,
      );
      expect(campaigns, "the winner's campaign row must survive").toHaveLength(1);
      const { rows: assets } = await harness.db.query<{ n: number }>(
        `select count(*)::int as n from asset where org_id = 'local' and campaign_id = $1`,
        [campaigns[0]!.id],
      );
      return {
        campaignId: campaigns[0]!.id,
        rows: assets[0]!.n,
        objects: (await store.list(inputPrefix("local", campaigns[0]!.id))).length,
      };
    }

    test("the create rollback leaves the winner's campaign and its assets alone", async () => {
      competingWriter();
      const res = await createCall();
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'Brief "copy" already exists.' });

      const after = await won();
      expect(after.rows, "the winner's asset row must survive").toBe(1);
      expect(after.objects, "the winner's object must survive").toBe(1);
      expect(
        await store.get((await store.list(inputPrefix("local", after.campaignId)))[0]!.key),
      ).toBeDefined();
      // Its first version is what made it a winner, and it is still there.
      const { rows: versions } = await harness.db.query<{ n: number }>(
        `select count(*)::int as n from brief_version where campaign_id = $1`,
        [after.campaignId],
      );
      expect(versions[0]!.n).toBe(1);
      // And the source it was copied from is untouched, as always.
      expect(await getAssetStore(tenant).readAsset("source-camp", "logo.png")).toEqual(PNG);
    });

    test("the duplicate rollback leaves them alone too", async () => {
      competingWriter();
      const res = await duplicateCall();
      expect(res.status).toBe(409);

      const after = await won();
      expect(after.rows).toBe(1);
      expect(after.objects).toBe(1);
      expect(await getAssetStore(tenant).readAsset("source-camp", "logo.png")).toEqual(PNG);
    });

    test("a cleanup failure on the DUPLICATE route still releases, and the original error surfaces", async () => {
      // The duplicate's half of the best-effort contract. The release is what
      // makes the campaign go away, so a store that refuses to free must not
      // stand in its way — and must not become the error the caller hears
      // either. "boom" is not EEXIST, so a 500 carrying "boom" is the only
      // acceptable answer: any other status would mean a different error won.
      vi.spyOn(PgBriefStore.prototype, "createBrief").mockRejectedValueOnce(new Error("boom"));
      vi.spyOn(ObjectAssetStore.prototype, "deleteAssets").mockRejectedValue(
        new Error("the cleanup exploded"),
      );
      const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const res = await duplicateCall();
      expect(res.status).toBe(500);

      // The release ran, so the reservation is gone — the thing the
      // best-effort free exists to protect.
      const { rows: left } = await harness.db.query<{ n: number }>(
        `select count(*)::int as n from campaign where org_id = 'local' and slug = 'copy'`,
      );
      expect(left[0]!.n).toBe(0);
      // And the swallowed error is not swallowed SILENTLY: a cleanup nobody can
      // see failing is how a store's refusal becomes a support ticket instead
      // of a log line. The message names the slug and the cause, in this
      // repo's `[x] …: ${errorMessage(error)}` shape.
      const said = warned.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(said).toContain('[campaigns] could not free the assets of "copy"');
      expect(said).toContain("after a failed duplicate");
      expect(said).toContain("the cleanup exploded");
    });
  });

  describe("with OBJECT_STORE=fs — staging's CURRENT configuration (PT-4b)", () => {
    // `STORE_BACKEND=postgres` with `OBJECT_STORE` unset is what staging runs,
    // and it is the combination the uuid argument broke: `FsAssetStore` keeps a
    // copied asset under `assets/inputs/<slug>/`, so `deleteAssets(<uuid>)` names
    // a directory it never wrote and the copied files survive the rollback with
    // no campaign left to ever free them.
    const tenant: TenantContext = { orgId: "local", userId: "u", roles: [], teamIds: [] };

    beforeEach(() => {
      delete process.env.OBJECT_STORE;
      resetAssetStore();
    });

    const copied = () => join(harness.projectRoot, "assets", "inputs", "copy", "logo.png");
    const original = () => join(harness.projectRoot, "assets", "inputs", "source-camp", "logo.png");

    async function seedSource(): Promise<void> {
      const briefs = new PgBriefStore(harness.db, "local", "u", [], []);
      await briefs.createCampaign("source-camp");
      await briefs.createBrief(brief("source-camp"));
      await getAssetStore(tenant).writeAsset("source-camp", "logo.png", PNG);
      expect(existsSync(original())).toBe(true);
    }

    test("the create rollback leaves no copied file under the target slug", async () => {
      await seedSource();
      vi.spyOn(PgBriefStore.prototype, "createBrief").mockRejectedValueOnce(new Error("boom"));

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
      // The whole copy is gone, directory and all…
      expect(existsSync(copied())).toBe(false);
      expect(existsSync(join(harness.projectRoot, "assets", "inputs", "copy"))).toBe(false);
      // …and the source's own file is untouched.
      expect(existsSync(original())).toBe(true);
      // No `asset` row either: on this backend there never was one, and the
      // rollback must not invent a table's worth of state by failing to free.
      expect(await assetCount(harness.db)).toBe(0);
    });

    test("the duplicate rollback leaves no copied file either", async () => {
      await seedSource();
      vi.spyOn(PgBriefStore.prototype, "createBrief").mockRejectedValueOnce(new Error("boom"));

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
      expect(existsSync(copied())).toBe(false);
      expect(existsSync(original())).toBe(true);
      const { rows: left } = await harness.db.query<{ n: number }>(
        `select count(*)::int as n from campaign where org_id = 'local' and slug = 'copy'`,
      );
      expect(left[0]!.n).toBe(0);
    });
  });
});
