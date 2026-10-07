import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
  type CampaignBrief,
} from "@campaignfoundry/CampaignOrchestration";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { inputKey, inputPrefix } from "../../../lib/object-store/object-keys.js";
import { resetObjectStoreClient, setObjectStoreClient } from "../../../lib/object-store/index.js";
import type { SqlClient } from "../../../lib/db/sql-client.js";
import type { TenantContext } from "../../../lib/tenant.js";
import {
  getAssetStore,
  getBriefStore,
  getDraftStore,
  resetAssetStore,
} from "../../../lib/ports/index.js";
import {
  mountTenantRoute,
  setupPgHarness,
  type PgHarness,
} from "../../__tests__/tenant-harness.js";
import assetsDeleteHandler from "../assets.delete.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_ALT = Buffer.concat([PNG, Buffer.from([0x00])]);

const brief = (id: string, logoPath = "logo.png"): CampaignBrief => ({
  schemaVersion: BRIEF_SCHEMA_VERSION,
  template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
  id,
  targetRegion: "US",
  targetAudience: "developers",
  campaignMessage: "Build faster",
  products: [{ id: "p1", name: "P1", primaryColor: "#1473E6", logoPath }],
  treatments: [{ id: "bold", layout: "headline-bottom", tone: "bold" }],
});

const owner: TenantContext = { orgId: "local", userId: "owner", roles: ["owner"], teamIds: [] };
const t2Member: TenantContext = {
  orgId: "local",
  userId: "m2",
  roles: ["member"],
  teamIds: ["t2"],
};

async function campaignIdOf(db: SqlClient, orgId: string, slug: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `select id from campaign where org_id = $1 and slug = $2`,
    [orgId, slug],
  );
  return rows[0]!.id;
}

const del = (tenant: TenantContext, query: string): Promise<Response> =>
  mountTenantRoute(assetsDeleteHandler, {
    method: "DELETE",
    path: "/campaigns/assets",
    tenant,
  })(new Request(`http://x/campaigns/assets?${query}`, { method: "DELETE" }));

describe("DELETE /campaigns/assets under s3", () => {
  let harness: PgHarness;
  let store: InMemoryObjectStore;
  let logo: string;
  let other: string;
  let camp2Logo: string;
  let campId: string;
  const SAVED_OBJECT_STORE = process.env.OBJECT_STORE;

  beforeEach(async () => {
    process.env.OBJECT_STORE = "s3";
    harness = await setupPgHarness();
    store = new InMemoryObjectStore();
    // BEFORE the first getAssetStore(): the registry builds one asset store per
    // org and hands it this client.
    setObjectStoreClient(store);
    resetAssetStore();
    const briefs = getBriefStore(owner);
    await harness.db.query(
      `insert into team (id, name, "memberCount", org_id, created_at) values ($1,$2,0,$3,now()),($4,$5,0,$3,now())`,
      ["t1", "Team One", "local", "t2", "Team Two"],
    );
    await briefs.createCampaign("camp", { teamId: "t1" });
    await briefs.createCampaign("camp2");
    await briefs.createCampaign("empty-camp");
    campId = await campaignIdOf(harness.db, "local", "camp");
    logo = (await getAssetStore(owner).writeAsset("camp", "logo.png", PNG)).id!;
    other = (await getAssetStore(owner).writeAsset("camp", "other.png", PNG_ALT)).id!;
    camp2Logo = (await getAssetStore(owner).writeAsset("camp2", "logo.png", PNG_ALT)).id!;
    // v1 names other.png's id; logo.png is free to delete in batch 1.
    await briefs.createBrief(brief("camp", other));
  });

  afterEach(async () => {
    resetAssetStore();
    resetObjectStoreClient();
    vi.restoreAllMocks();
    if (SAVED_OBJECT_STORE === undefined) delete process.env.OBJECT_STORE;
    else process.env.OBJECT_STORE = SAVED_OBJECT_STORE;
    await harness.cleanup();
  });

  /** Rows for a campaign's input assets, by org and slug. */
  const rows = async (orgId: string, slug: string) =>
    (
      await harness.db.query<{ id: string; name: string }>(
        `select id, name from asset where org_id = $1 and campaign_id = (select id from campaign where org_id = $1 and slug = $2) order by name`,
        [orgId, slug],
      )
    ).rows;

  /** Object keys under a campaign's `inputs/` prefix, by org and slug. */
  const objects = async (orgId: string, slug: string) =>
    (await store.list(inputPrefix(orgId, await campaignIdOf(harness.db, orgId, slug)))).map(
      (o) => o.key,
    );

  // --- Batch 1 ---

  test("DELETE /campaigns/assets under s3 deletes by id and removes the row and the object but not the neighbour", async () => {
    const res = await del(owner, `briefId=camp&id=${logo}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });

    // The row and the object are both gone; only the neighbour remains.
    expect((await rows("local", "camp")).map((r) => r.name)).toEqual(["other.png"]);
    expect(await objects("local", "camp")).toEqual([inputKey("local", campId, other)]);
    // And the neighbour's bytes survive (row and object).
    expect(await getAssetStore(owner).readAssetById(other)).toEqual(PNG_ALT);
    expect(Buffer.from((await store.get(inputKey("local", campId, other)))!.bytes)).toEqual(
      PNG_ALT,
    );
    // The deleted asset's object is gone:
    expect(await store.get(inputKey("local", campId, logo))).toBeUndefined();
  });

  test("DELETE /campaigns/assets under s3 deletes by name", async () => {
    const res = await del(owner, "briefId=camp&name=logo.png");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect((await rows("local", "camp")).map((r) => r.name)).toEqual(["other.png"]);
    expect(await objects("local", "camp")).toEqual([inputKey("local", campId, other)]);
    expect(Buffer.from((await store.get(inputKey("local", campId, other)))!.bytes)).toEqual(
      PNG_ALT,
    );
    expect(await store.get(inputKey("local", campId, logo))).toBeUndefined();
  });

  test("DELETE /campaigns/assets under s3 answers 404 for an id that another campaign owns and removes nothing", async () => {
    const beforeRows = await rows("local", "camp");
    const beforeObjects = await objects("local", "camp");
    const beforeOtherRows = await rows("local", "camp2");
    const beforeOtherObjects = await objects("local", "camp2");
    const res = await del(owner, `briefId=camp&id=${camp2Logo}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: `Asset "${camp2Logo}" not found.` });
    // camp is unchanged...
    expect(await rows("local", "camp")).toEqual(beforeRows);
    expect(await objects("local", "camp")).toEqual(beforeObjects);
    // ...and camp2's foreign id is still whole, byte for byte.
    expect(await rows("local", "camp2")).toEqual(beforeOtherRows);
    expect(await objects("local", "camp2")).toEqual(beforeOtherObjects);
    expect(await getAssetStore(owner).readAssetById(camp2Logo)).toEqual(PNG_ALT);
  });

  // --- Batch 2 ---

  test("DELETE /campaigns/assets under s3 answers 404 for an id that another org owns and removes nothing", async () => {
    await harness.db.query(
      `insert into org (id, name, slug, created_at) values ('other', 'Other', 'other', now())`,
    );
    const otherTenant: TenantContext = {
      orgId: "other",
      userId: "u",
      roles: ["owner"],
      teamIds: [],
    };
    await getBriefStore(otherTenant).createCampaign("camp");
    const otherLogo = (await getAssetStore(otherTenant).writeAsset("camp", "logo.png", PNG)).id!;
    const otherCampId = await campaignIdOf(harness.db, "other", "camp");

    const beforeRows = await rows("local", "camp");
    const beforeObjects = await objects("local", "camp");
    const res = await del(owner, `briefId=camp&id=${otherLogo}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: `Asset "${otherLogo}" not found.` });
    // local's camp is untouched.
    expect(await rows("local", "camp")).toEqual(beforeRows);
    expect(await objects("local", "camp")).toEqual(beforeObjects);
    // The other org's row and object survive, byte for byte.
    expect(await rows("other", "camp")).toEqual([{ id: otherLogo, name: "logo.png" }]);
    expect(await objects("other", "camp")).toEqual([inputKey("other", otherCampId, otherLogo)]);
    expect(
      Buffer.from((await store.get(inputKey("other", otherCampId, otherLogo)))!.bytes),
    ).toEqual(PNG);
  });

  test("DELETE /campaigns/assets under s3 answers the same 404 for a hidden campaign and an absent one", async () => {
    // by id: t2Member on the t1 campaign is hidden; owner on a missing campaign is absent.
    const byIdHidden = await del(t2Member, `briefId=camp&id=${logo}`);
    const byIdAbsent = await del(owner, `briefId=no-such-campaign&id=${logo}`);
    expect(byIdHidden.status).toBe(404);
    expect(byIdAbsent.status).toBe(404);
    const byIdBody = `{"error":"Asset \\"${logo}\\" not found."}`;
    expect(await byIdHidden.text()).toBe(byIdBody);
    expect(await byIdAbsent.text()).toBe(byIdBody);

    // by name: the same pair.
    const byNameHidden = await del(t2Member, "briefId=camp&name=logo.png");
    const byNameAbsent = await del(owner, "briefId=no-such-campaign&name=logo.png");
    expect(byNameHidden.status).toBe(404);
    expect(byNameAbsent.status).toBe(404);
    const byNameBody = `{"error":"Asset \\"logo.png\\" not found."}`;
    expect(await byNameHidden.text()).toBe(byNameBody);
    expect(await byNameAbsent.text()).toBe(byNameBody);

    // The hidden campaign's row and object are intact.
    expect((await rows("local", "camp")).map((r) => r.name)).toEqual(["logo.png", "other.png"]);
    expect(await getAssetStore(owner).readAssetById(logo)).toEqual(PNG);
  });

  // --- Batch 3: references (each: 409 body, rows and objects unchanged) ---

  test("DELETE /campaigns/assets under s3 answers 409 when the latest version names the id", async () => {
    // Base v1 names other.png; rewrite so the latest version names logo's id.
    await getBriefStore(owner).rewriteBrief(brief("camp", logo));
    const beforeRows = await rows("local", "camp");
    const beforeObjects = await objects("local", "camp");

    const res = await del(owner, `briefId=camp&id=${logo}`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Asset "logo.png" is in use.' });
    expect(await rows("local", "camp")).toEqual(beforeRows);
    expect(await objects("local", "camp")).toEqual(beforeObjects);
  });

  test("DELETE /campaigns/assets under s3 answers 409 when the latest version still names the asset by its legacy path", async () => {
    // A path ref is legal under s3 for a version written before ids existed, and
    // the store's position() cannot see it: this proves the route's own check.
    await getBriefStore(owner).rewriteBrief(brief("camp", "assets/inputs/camp/logo.png"));
    const beforeRows = await rows("local", "camp");
    const beforeObjects = await objects("local", "camp");

    const res = await del(owner, `briefId=camp&id=${logo}`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Asset "logo.png" is in use.' });
    expect(await rows("local", "camp")).toEqual(beforeRows);
    expect(await objects("local", "camp")).toEqual(beforeObjects);
  });

  test("DELETE /campaigns/assets under s3 answers 409 when only an older version names the id and keeps the row and the object", async () => {
    // v1 (base) names other; add a version naming logo, then one naming other
    // again so the LATEST does not name logo but an older one does.
    await getBriefStore(owner).rewriteBrief(brief("camp", logo));
    await getBriefStore(owner).rewriteBrief(brief("camp", other));
    const beforeRows = await rows("local", "camp");
    const beforeObjects = await objects("local", "camp");

    const res = await del(owner, `briefId=camp&id=${logo}`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Asset "logo.png" is in use.' });
    expect(await rows("local", "camp")).toEqual(beforeRows);
    expect(await objects("local", "camp")).toEqual(beforeObjects);
    expect(await getAssetStore(owner).readAssetById(logo)).toEqual(PNG);
  });

  test("DELETE /campaigns/assets under s3 answers 409 when the callers draft names the id", async () => {
    const drafts = getDraftStore(owner);
    await drafts.writeDraft(campId, owner.userId, { products: [{ logoPath: logo }] }, null);
    const beforeRows = await rows("local", "camp");
    const beforeObjects = await objects("local", "camp");

    const res = await del(owner, `briefId=camp&id=${logo}`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Asset "logo.png" is in use.' });
    expect(await rows("local", "camp")).toEqual(beforeRows);
    expect(await objects("local", "camp")).toEqual(beforeObjects);
  });

  // --- Batch 4: the races ---

  test("DELETE /campaigns/assets under s3 answers 409 when a version naming the asset commits just before the free", async () => {
    // v1 (base) names only other.png, so the route's pre-checks pass.
    const assetStore = getAssetStore(owner);
    const real = assetStore.freeUnreferencedAssets.bind(assetStore);
    const revBefore = await getBriefStore(owner).getRevision("camp");
    const beforeRows = await rows("local", "camp");
    const beforeObjects = await objects("local", "camp");

    vi.spyOn(assetStore, "freeUnreferencedAssets").mockImplementation(async (campaign, ids) => {
      // A Save commits under the lock, naming the asset the route just passed.
      await getBriefStore(owner).rewriteBrief(brief("camp", logo), { expectedRevision: revBefore });
      return real(campaign, ids);
    });

    const res = await del(owner, `briefId=camp&id=${logo}`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Asset "logo.png" is in use.' });
    // The store refused: the row and the object are still there...
    expect(await rows("local", "camp")).toEqual(beforeRows);
    expect(await objects("local", "camp")).toEqual(beforeObjects);
    expect(await getAssetStore(owner).readAssetById(logo)).toEqual(PNG);
    // ...and the latest stored version does now name the id.
    const stored = await getBriefStore(owner).findBriefById("camp");
    expect(stored).toBeDefined();
    expect(stored!.brief.products[0].logoPath).toBe(logo);
  });

  test("DELETE /campaigns/assets under s3 answers 404 and frees nothing when the campaign is tombstoned after the resolve", async () => {
    const assetStore = getAssetStore(owner);
    const real = assetStore.freeUnreferencedAssets.bind(assetStore);
    const beforeRows = await rows("local", "camp");
    const beforeObjects = await objects("local", "camp");

    vi.spyOn(assetStore, "freeUnreferencedAssets").mockImplementation(async (campaign, ids) => {
      // Tombstone AFTER the route's resolve and before the free (D231).
      await harness.db.query(
        "update campaign set deleted_at = now() where org_id = 'local' and slug = $1",
        [campaign],
      );
      return real(campaign, ids);
    });

    const res = await del(owner, `briefId=camp&id=${logo}`);
    // The re-resolve after the free sees the tombstone and answers the same 404,
    // so the bytes never come this route's way.
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: `Asset "${logo}" not found.` });
    // The asset row and object STILL EXIST: a tombstoned campaign's bytes belong
    // to the purge, never to this route.
    expect(await rows("local", "camp")).toEqual(beforeRows);
    expect(await objects("local", "camp")).toEqual(beforeObjects);
    expect(Buffer.from((await store.get(inputKey("local", campId, logo)))!.bytes)).toEqual(PNG);
    expect(Buffer.from((await store.get(inputKey("local", campId, other)))!.bytes)).toEqual(
      PNG_ALT,
    );
  });

  // --- Batch 5: repeated parameters ---

  test("DELETE /campaigns/assets under s3 answers 400 for a repeated id or name and removes nothing", async () => {
    const beforeRows = await rows("local", "camp");
    const beforeObjects = await objects("local", "camp");

    // A repeated `id` beside a single `name` would otherwise ignore the id and
    // delete by name; a repeated `name` beside a single `id` would ignore the name.
    const repeatedId = await del(owner, `briefId=camp&id=${logo}&id=${other}&name=logo.png`);
    expect(repeatedId.status).toBe(400);
    const repeatedName = await del(owner, `briefId=camp&name=logo.png&name=other.png&id=${logo}`);
    expect(repeatedName.status).toBe(400);

    // Neither asset row nor object was touched.
    expect(await rows("local", "camp")).toEqual(beforeRows);
    expect(await objects("local", "camp")).toEqual(beforeObjects);
    expect(await getAssetStore(owner).readAssetById(logo)).toEqual(PNG);
    expect(Buffer.from((await store.get(inputKey("local", campId, logo)))!.bytes)).toEqual(PNG);
    expect(Buffer.from((await store.get(inputKey("local", campId, other)))!.bytes)).toEqual(
      PNG_ALT,
    );
  });
});
