import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
  type CampaignBrief,
} from "@campaignfoundry/CampaignOrchestration";
import type { TenantContext } from "../../../lib/tenant.js";
import type { SqlClient } from "../../../lib/db/sql-client.js";
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
const t1Member: TenantContext = {
  orgId: "local",
  userId: "m1",
  roles: ["member"],
  teamIds: ["t1"],
};
const t2Member: TenantContext = {
  orgId: "local",
  userId: "m2",
  roles: ["member"],
  teamIds: ["t2"],
};

async function campaignIdOf(db: SqlClient, slug: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `select id from campaign where org_id = 'local' and slug = $1`,
    [slug],
  );
  return rows[0]!.id;
}

/** Compare the on-disk asset state of every (tenant, slug) pair. */
type Pair = readonly [TenantContext, string];
async function state(pairs: readonly Pair[]): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [tenant, slug] of pairs) {
    const store = getAssetStore(tenant);
    const entries = await store.listAssets(slug);
    const bytes: Record<string, string> = {};
    for (const e of entries) {
      const buf = await store.readAsset(slug, e.name);
      bytes[e.name] = buf ? buf.toString("hex") : "ABSENT";
    }
    out[`${tenant.userId}:${slug}`] = { names: entries.map((e) => e.name), bytes };
  }
  return out;
}

const del = (tenant: TenantContext, query: string): Promise<Response> =>
  mountTenantRoute(assetsDeleteHandler, {
    method: "DELETE",
    path: "/campaigns/assets",
    tenant,
  })(new Request(`http://x/campaigns/assets?${query}`, { method: "DELETE" }));

describe("DELETE /campaigns/assets on Postgres with file assets (OBJECT_STORE=fs)", () => {
  let harness: PgHarness;
  const SAVED_OBJECT_STORE = process.env.OBJECT_STORE;

  beforeEach(async () => {
    delete process.env.OBJECT_STORE;
    harness = await setupPgHarness();
    resetAssetStore();
    const briefs = getBriefStore(owner);
    await harness.db.query(
      `insert into team (id, name, "memberCount", org_id, created_at) values ($1,$2,0,$3,now()),($4,$5,0,$3,now())`,
      ["t1", "Team One", "local", "t2", "Team Two"],
    );
    await briefs.createCampaign("camp", { teamId: "t1" });
    await briefs.createBrief(brief("camp", "assets/inputs/camp/logo.png"));
    const assets = getAssetStore(owner);
    await assets.writeAsset("camp", "logo.png", PNG);
    await assets.writeAsset("camp", "other.png", PNG_ALT);
    await briefs.createCampaign("camp2");
    await briefs.createBrief(brief("camp2", "assets/inputs/camp2/logo.png"));
    await assets.writeAsset("camp2", "logo.png", PNG_ALT);
    await briefs.createCampaign("empty-camp");
  });

  afterEach(async () => {
    resetAssetStore();
    vi.restoreAllMocks();
    if (SAVED_OBJECT_STORE === undefined) delete process.env.OBJECT_STORE;
    else process.env.OBJECT_STORE = SAVED_OBJECT_STORE;
    await harness.cleanup();
  });

  // --- Batch 1 ---

  test("DELETE /campaigns/assets on Postgres with file assets removes the file of a visible campaign and nothing else", async () => {
    const beforeVersions = (
      await harness.db.query<{ n: number }>(`select count(*)::int as n from brief_version`)
    ).rows[0]!.n;
    const res = await del(owner, "briefId=camp&name=other.png");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });

    const store = getAssetStore(owner);
    expect((await store.listAssets("camp")).map((e) => e.name)).toEqual(["logo.png"]);
    expect(await store.readAsset("camp", "logo.png")).toEqual(PNG);
    // A same-named file of a second campaign survives byte for byte.
    expect(await store.readAsset("camp2", "logo.png")).toEqual(PNG_ALT);
    // The campaign row and its versions are unchanged: a delete never writes a version.
    expect(
      (await harness.db.query<{ n: number }>(`select count(*)::int as n from brief_version`))
        .rows[0]!.n,
    ).toBe(beforeVersions);
  });

  test("DELETE /campaigns/assets on Postgres with file assets lets a member of the campaigns team delete", async () => {
    const res = await del(t1Member, "briefId=camp&name=other.png");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect((await getAssetStore(t1Member).listAssets("camp")).map((e) => e.name)).toEqual([
      "logo.png",
    ]);
  });

  test("DELETE /campaigns/assets on Postgres with file assets accepts the campaign uuid as briefId", async () => {
    const uuid = await campaignIdOf(harness.db, "camp");
    const res = await del(owner, `briefId=${uuid}&name=other.png`);
    expect(res.status).toBe(200);
    // The file under the SLUG's directory is gone, not a uuid-keyed one.
    expect(await getAssetStore(owner).readAsset("camp", "other.png")).toBeUndefined();
    expect(await getAssetStore(owner).readAsset("camp", "logo.png")).toEqual(PNG);
  });

  // --- Batch 2: the one 404 (bodies compared byte for byte) ---

  test("DELETE /campaigns/assets answers the same 404 for a hidden campaign, an absent campaign and an unknown asset", async () => {
    // (a) t2Member on the t1 campaign: hidden by team.
    const hidden = await del(t2Member, "briefId=camp&name=logo.png");
    expect(hidden.status).toBe(404);
    // (b) owner on a briefId that names no campaign.
    const absent = await del(owner, "briefId=no-such-campaign&name=logo.png");
    expect(absent.status).toBe(404);
    // (c) owner on a visible campaign that holds no logo.png.
    const unknown = await del(owner, "briefId=empty-camp&name=logo.png");
    expect(unknown.status).toBe(404);
    // The IDENTICAL body for all three, byte for byte — never a literal comparison.
    const [hiddenBody, absentBody, unknownBody] = [
      await hidden.text(),
      await absent.text(),
      await unknown.text(),
    ];
    expect(hiddenBody).toBe(absentBody);
    expect(absentBody).toBe(unknownBody);
    expect(unknownBody).toBe('{"error":"Asset \\"logo.png\\" not found."}');
    // The hidden campaign's logo.png is still on disk with its bytes.
    expect(await getAssetStore(owner).readAsset("camp", "logo.png")).toEqual(PNG);
  });

  test("DELETE /campaigns/assets answers 404 for another orgs campaign and removes nothing", async () => {
    await harness.db.query(
      `insert into org (id, name, slug, created_at) values ('other', 'Other', 'other', now())`,
    );
    const otherOrg: TenantContext = { orgId: "other", userId: "u", roles: [], teamIds: [] };
    const res = await del(otherOrg, "briefId=camp&name=logo.png");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Asset "logo.png" not found.' });
    // The local file survives: a foreign id or name never reaches the free.
    expect(await getAssetStore(owner).readAsset("camp", "logo.png")).toEqual(PNG);
  });

  test("DELETE /campaigns/assets answers 404 for a tombstoned campaign and removes nothing", async () => {
    await harness.db.query(
      `update campaign set deleted_at = now() where org_id = 'local' and slug = 'camp'`,
    );
    const res = await del(owner, "briefId=camp&name=logo.png");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Asset "logo.png" not found.' });
    // Tombstoned bytes belong to the purge, never to this route: still on disk.
    expect(await getAssetStore(owner).readAsset("camp", "logo.png")).toEqual(PNG);
  });

  // --- Batch 3: references ---

  test("DELETE /campaigns/assets on Postgres answers 500 and frees nothing when the latest version no longer parses", async () => {
    const uuid = await campaignIdOf(harness.db, "camp");
    await harness.db.query(
      `update brief_version set body = $1
         where campaign_id = $2
           and version = (select max(version) from brief_version where campaign_id = $2)`,
      [JSON.stringify({ id: "camp" }), uuid],
    );
    const pairs: readonly Pair[] = [
      [owner, "camp"],
      [owner, "camp2"],
    ];
    const before = await state(pairs);
    const res = await del(owner, "briefId=camp&name=logo.png");
    expect(res.status).toBe(500);
    expect(await state(pairs)).toEqual(before);
    expect(await getAssetStore(owner).readAsset("camp", "logo.png")).toEqual(PNG);
  });

  test("DELETE /campaigns/assets on Postgres with file assets answers 409 when the latest saved version names the asset by path", async () => {
    const pairs: readonly Pair[] = [
      [owner, "camp"],
      [owner, "camp2"],
    ];
    const before = await state(pairs);
    const res = await del(owner, "briefId=camp&name=logo.png");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Asset "logo.png" is in use.' });
    expect(await state(pairs)).toEqual(before);
  });

  test("DELETE /campaigns/assets on Postgres with file assets answers 409 when the callers draft names the asset", async () => {
    const uuid = await campaignIdOf(harness.db, "camp");
    // Brief names only other.png, so the saved version does NOT block logo.png.
    await getBriefStore(owner).rewriteBrief(brief("camp", "assets/inputs/camp/other.png"));
    const drafts = getDraftStore(owner);

    const before = await state([[owner, "camp"]] as readonly Pair[]);
    // The caller's own draft names logo.png -> 409.
    await drafts.writeDraft(
      uuid,
      owner.userId,
      { products: [{ logoPath: "assets/inputs/camp/logo.png" }] },
      null,
    );
    // Another user's draft also names logo.png -> NOT consulted.
    await drafts.writeDraft(
      uuid,
      t1Member.userId,
      { products: [{ logoPath: "assets/inputs/camp/logo.png" }] },
      null,
    );
    const res = await del(owner, "briefId=camp&name=logo.png");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Asset "logo.png" is in use.' });
    expect(await state([[owner, "camp"]] as readonly Pair[])).toEqual(before);

    // Delete the CALLER's draft only: the other user's draft still names logo.png,
    // yet the route answers 200 — it reads the caller's draft alone (DECISION 5).
    await drafts.deleteDraft(uuid, owner.userId);
    const again = await del(owner, "briefId=camp&name=logo.png");
    expect(again.status).toBe(200);
    expect(await getAssetStore(owner).readAsset("camp", "logo.png")).toBeUndefined();
    expect(await getAssetStore(owner).readAsset("camp", "other.png")).toEqual(PNG_ALT);
  });

  test("DELETE /campaigns/assets on Postgres with file assets frees an asset that only an older version names", async () => {
    // v1 (base fixture) names logo.png; add v2 naming only other.png.
    const rev = await getBriefStore(owner).getRevision("camp");
    await getBriefStore(owner).rewriteBrief(brief("camp", "assets/inputs/camp/other.png"), {
      expectedRevision: rev,
    });
    const beforeVersions = (
      await harness.db.query<{ n: number }>(`select count(*)::int as n from brief_version`)
    ).rows[0]!.n;

    const res = await del(owner, "briefId=camp&name=logo.png");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    // The file under this campaign is gone (the documented trade on file assets).
    expect(await getAssetStore(owner).readAsset("camp", "logo.png")).toBeUndefined();
    expect(await getAssetStore(owner).readAsset("camp", "other.png")).toEqual(PNG_ALT);
    // And no version was created or destroyed by the delete.
    expect(
      (await harness.db.query<{ n: number }>(`select count(*)::int as n from brief_version`))
        .rows[0]!.n,
    ).toBe(beforeVersions);
  });
});
