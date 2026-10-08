import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { setCapabilities } from "../../../lib/capabilities.js";
import { inputPrefix } from "../../../lib/object-store/object-keys.js";
import { resetObjectStoreClient, setObjectStoreClient } from "../../../lib/object-store/index.js";
import { getAssetStore, getBriefStore, resetAssetStore } from "../../../lib/ports/index.js";
import { FsAssetStore } from "../../../lib/ports/fs-asset-store.js";
import { ObjectAssetStore } from "../../../lib/ports/object-asset-store.js";
import { PgBriefStore } from "../../../lib/ports/pg-brief-store.js";
import { FsBriefStore } from "../../../lib/ports/fs-brief-store.js";
import type { CopyAssetsOptions } from "../../../lib/ports/asset-store.port.js";
import type { SqlClient } from "../../../lib/db/sql-client.js";
import type { TenantContext } from "../../../lib/tenant.js";
import {
  LOCAL_TENANT,
  mountTenantRoute,
  setupFsHarness,
  setupPgHarness,
  type FsHarness,
  type PgHarness,
} from "../../__tests__/tenant-harness.js";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
} from "@campaignfoundry/CampaignOrchestration";
import assetsPostHandler from "../assets.post.js";
import duplicatePostHandler from "../briefs/[id]/duplicate.post.js";
import indexPostHandler from "../index.post.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_ALT = Buffer.concat([PNG, Buffer.from([0x00])]);
const PNG_ALT2 = Buffer.concat([PNG, Buffer.from([0x00, 0x00])]);
const PNG_ALT3 = Buffer.concat([PNG, Buffer.from([0x00, 0x00, 0x00])]);
const PNG_ALT4 = Buffer.concat([PNG, Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00])]);
const PNG_MARK = Buffer.concat([PNG, Buffer.from([0x01])]);
const PNG_THIRD = Buffer.concat([PNG, Buffer.from([0x00, 0x00, 0x00])]);
const NESTED = Buffer.from("nested-third-campaign-file-bytes");

const OWNER: TenantContext = { orgId: "local", userId: "owner", roles: ["owner"], teamIds: [] };
const ONLY_T1: TenantContext = { orgId: "local", userId: "u1", roles: [], teamIds: ["t1"] };

const pathRef = (slug: string): string => `assets/inputs/${slug}/logo.png`;

const baseBrief = (id: string, own: string): CampaignBrief => ({
  schemaVersion: BRIEF_SCHEMA_VERSION,
  template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
  id,
  mode: "brief",
  targetRegion: "US",
  targetAudience: "developers",
  campaignMessage: "Build faster",
  products: [{ id: "p1", name: "P1", primaryColor: "#1473E3", logoPath: own }],
});

interface Counts {
  readonly assets: number;
  readonly versions: number;
  readonly campaigns: number;
}

const counts = async (db: SqlClient): Promise<Counts> => {
  const one = async (sql: string): Promise<number> => {
    const { rows } = await db.query<{ n: number }>(sql);
    return Number(rows[0]!.n);
  };
  return {
    assets: await one(`select count(*)::int as n from asset`),
    versions: await one(`select count(*)::int as n from brief_version`),
    campaigns: await one(`select count(*)::int as n from campaign`),
  };
};

const upload = async (
  tenant: TenantContext,
  briefId: string,
  name = "logo.png",
  bytes: Buffer = PNG,
): Promise<string> => {
  const res = await mountTenantRoute(assetsPostHandler, {
    method: "POST",
    path: "/campaigns/assets",
    tenant,
  })(
    new Request("http://x/campaigns/assets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ briefId, name, contentBase64: bytes.toString("base64") }),
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { id?: string }).id!;
};

const createFrom = (tenant: TenantContext, body: unknown) =>
  mountTenantRoute(indexPostHandler, { method: "POST", path: "/campaigns", tenant })(
    new Request("http://x/campaigns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const duplicate = (tenant: TenantContext, id: string, name: string) =>
  mountTenantRoute(duplicatePostHandler, {
    method: "POST",
    path: "/campaigns/briefs/:id/duplicate",
    tenant,
  })(
    new Request(`http://x/campaigns/briefs/${id}/duplicate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  );

/**
 * Lane FU-third-campaign-copy (D238): a sourced create and a duplicate must hand
 * `copyOnly` to the THIRD campaign's copy, so a brief that names one asset of a
 * third campaign copies only that asset — not the third campaign's whole library.
 * The source campaign's own copy is still whole (Q8).
 */

describe("copy third-campaign-only under s3 on pg (FU-third-campaign-copy, D238)", () => {
  let harness: PgHarness;
  let objectStore: InMemoryObjectStore;
  let ownerStore: PgBriefStore;
  const SAVED_BACKEND = process.env.STORE_BACKEND;
  const SAVED_OBJECT_STORE = process.env.OBJECT_STORE;

  let seq = 0;
  const unique = (prefix: string): string => `${prefix}-${(seq += 1)}`;

  const store = () => getAssetStore(ONLY_T1);

  let mint: ReturnType<typeof vi.spyOn>;
  let seen: Map<string, ReadonlySet<string>>;
  let createdByTarget: Map<string, string[]>;
  let free: ReturnType<typeof vi.spyOn>;
  let copy: ReturnType<typeof vi.spyOn>;
  let deleteAssets: ReturnType<typeof vi.spyOn>;

  const minted = async () =>
    (await mint.mock.results[0]!.value) as { campaignId: string; slug: string };

  const watch = () => {
    seen = new Map();
    createdByTarget = new Map();
    mint = vi.spyOn(PgBriefStore.prototype, "createCampaign");
    const real = ObjectAssetStore.prototype.copyAssets;
    copy = vi.spyOn(ObjectAssetStore.prototype, "copyAssets").mockImplementation(async function (
      this: ObjectAssetStore,
      from: string,
      to: string,
      options?: CopyAssetsOptions,
    ) {
      const result = await real.call(this, from, to, options);
      if (!seen.has(from)) seen.set(from, new Set(result.created));
      const arr = createdByTarget.get(to) ?? [];
      for (const id of result.created) arr.push(id);
      createdByTarget.set(to, arr);
      return result;
    });
    free = vi.spyOn(ObjectAssetStore.prototype, "freeUnreferencedAssets");
    deleteAssets = vi.spyOn(ObjectAssetStore.prototype, "deleteAssets");
    return { mint, seen, createdByTarget, free, copy, deleteAssets };
  };

  const uuidOf = async (slug: string): Promise<string> => {
    const { rows } = await harness.db.query<{ id: string }>(
      `select id from campaign where org_id = $1 and slug = $2`,
      ["local", slug],
    );
    return rows[0]!.id;
  };

  const assetRows = async (campaignId: string): Promise<string[]> =>
    (
      await harness.db.query<{ name: string }>(
        `select name from asset where org_id = $1 and campaign_id = $2 order by name`,
        ["local", campaignId],
      )
    ).rows.map((r) => r.name);

  const keysOf = async (slug: string): Promise<string[]> => {
    const uuid = await uuidOf(slug);
    return (await objectStore.list(inputPrefix("local", uuid))).map((o) => o.key).sort();
  };

  const expectSourcesUntouched = async (
    ...who: { slug: string; rows: readonly string[]; objects: number }[]
  ): Promise<void> => {
    for (const w of who) {
      const uuid = await uuidOf(w.slug);
      expect(await assetRows(uuid)).toEqual([...w.rows]);
      expect((await keysOf(w.slug)).length).toBe(w.objects);
    }
  };

  /** Reassign a campaign to t2 before the request, to capture the resolve-time-hidden 404. */
  const preHide = async (slug: string): Promise<void> => {
    await harness.db.query(
      `update campaign set team_id = 't2' where org_id = 'local' and slug = $1`,
      [slug],
    );
  };

  /** S: logo.png=PNG, extra.png=PNG_ALT. T: logo.png=PNG_THIRD, alt.png=PNG_ALT2, bg.png=PNG_ALT3.
   * S's stored brief names T's alt.png, so only alt.png is carried from T. With `ref`
   * `"path"` the third-campaign ref is a path (`assets/inputs/<third>/alt.png`) instead
   * of an id; `"id"` (the default) keeps every existing caller untouched. */
  const seedSourceWithThird = async (
    prefix: string,
    ref: "id" | "path" = "id",
  ): Promise<{
    slug: string;
    campaignId: string;
    third: { slug: string; altId: string; logoId: string; bgId: string };
  }> => {
    const thirdSlug = unique("third");
    await ownerStore.createCampaign(thirdSlug, { teamId: "t1" });
    const logoId = await upload(OWNER, thirdSlug, "logo.png", PNG_THIRD);
    const altId = await upload(OWNER, thirdSlug, "alt.png", PNG_ALT2);
    const bgId = await upload(OWNER, thirdSlug, "bg.png", PNG_ALT3);
    const slug = unique(prefix);
    const { campaignId } = await ownerStore.createCampaign(slug, { teamId: "t1" });
    await upload(OWNER, slug, "logo.png", PNG);
    await upload(OWNER, slug, "extra.png", PNG_ALT);
    await ownerStore.createBrief(
      {
        ...baseBrief(slug, pathRef(slug)),
        products: [
          {
            id: "p1",
            name: "P1",
            primaryColor: "#1473E3",
            logoPath: ref === "path" ? `assets/inputs/${thirdSlug}/alt.png` : altId,
          },
        ],
      },
      { teamId: "t1" },
    );
    return { slug, campaignId, third: { slug: thirdSlug, altId, logoId: logoId, bgId } };
  };

  beforeAll(async () => {
    setCapabilities({ motion: true });
    process.env.OBJECT_STORE = "s3";
    harness = await setupPgHarness();
    objectStore = new InMemoryObjectStore();
    setObjectStoreClient(objectStore);
    resetAssetStore();
    ownerStore = new PgBriefStore(harness.db, "local", "owner", ["owner"], []);
    await harness.db.query(
      `insert into team (id, name, "memberCount", org_id, created_at) values
         ($1, $2, 0, $3, now()), ($4, $5, 0, $3, now())`,
      ["t1", "Team One", "local", "t2", "Team Two"],
    );
  });

  afterEach(() => {
    resetAssetStore();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    setCapabilities({ motion: false, reason: "not probed" });
    resetObjectStoreClient();
    resetAssetStore();
    if (SAVED_BACKEND === undefined) delete process.env.STORE_BACKEND;
    else process.env.STORE_BACKEND = SAVED_BACKEND;
    if (SAVED_OBJECT_STORE === undefined) delete process.env.OBJECT_STORE;
    else process.env.OBJECT_STORE = SAVED_OBJECT_STORE;
    await harness.cleanup();
  });

  test("s3, create copies only the named third-campaign asset", async () => {
    const { slug, campaignId, third } = await seedSourceWithThird(unique("src"));
    const snapshot = await counts(harness.db);
    const { copy, free, deleteAssets } = watch();

    const res = await createFrom(ONLY_T1, { name: unique("copy"), source: campaignId });
    expect(res.status).toBe(201);
    const { slug: newSlug, campaignId: newUuid } = (await res.json()) as {
      campaignId: string;
      slug: string;
      revision: string;
    };

    // The new campaign holds S's whole source copy PLUS only the one asset the brief named of T.
    expect((await assetRows(newUuid)).sort()).toEqual(["alt.png", "extra.png", "logo.png"]);
    expect((await keysOf(newSlug)).length).toBe(3);
    // The source is copied wholesale (two-arg); the third is narrowed.
    expect(copy).toHaveBeenCalledWith(slug, newSlug);
    expect(copy).toHaveBeenCalledWith(third.slug, newSlug, { only: ["alt.png"] });
    // The stored ref remapped onto the new campaign's own id.
    const stored = (await ownerStore.findBriefById(newSlug))!.brief;
    const logoRef = stored.products[0].logoPath;
    expect((await store().assetOwner(logoRef))?.slug).toBe(newSlug);
    expect(free).not.toHaveBeenCalled();
    expect(deleteAssets).not.toHaveBeenCalled();

    // Second half: the unreferenced third-campaign asset (bg.png) is not copied, and T is untouched.
    expect((await assetRows(newUuid)).some((n) => n === "bg.png")).toBe(false);
    await expectSourcesUntouched(
      { slug: slug, rows: ["extra.png", "logo.png"], objects: 2 },
      { slug: third.slug, rows: ["alt.png", "bg.png", "logo.png"], objects: 3 },
    );
    expect((await counts(harness.db)).versions).toBe(snapshot.versions + 1);
  });

  test("s3, duplicate copies only the named third-campaign asset", async () => {
    const { slug, campaignId, third } = await seedSourceWithThird(unique("src"));
    const snapshot = await counts(harness.db);
    const { copy, free, deleteAssets } = watch();

    const res = await duplicate(ONLY_T1, campaignId, unique("copy"));
    expect(res.status).toBe(201);
    const newSlug = (await res.json()).brief.id as string;
    const newUuid = await uuidOf(newSlug);

    expect((await assetRows(newUuid)).sort()).toEqual(["alt.png", "extra.png", "logo.png"]);
    expect((await keysOf(newSlug)).length).toBe(3);
    expect(copy).toHaveBeenCalledWith(slug, newSlug);
    expect(copy).toHaveBeenCalledWith(third.slug, newSlug, { only: ["alt.png"] });
    const stored = (await ownerStore.findBriefById(newSlug))!.brief;
    const logoRef = stored.products[0].logoPath;
    expect((await store().assetOwner(logoRef))?.slug).toBe(newSlug);
    expect(free).not.toHaveBeenCalled();
    expect(deleteAssets).not.toHaveBeenCalled();

    expect((await assetRows(newUuid)).some((n) => n === "bg.png")).toBe(false);
    await expectSourcesUntouched(
      { slug: slug, rows: ["extra.png", "logo.png"], objects: 2 },
      { slug: third.slug, rows: ["alt.png", "bg.png", "logo.png"], objects: 3 },
    );
    expect((await counts(harness.db)).versions).toBe(snapshot.versions + 1);
  });

  test("s3, a third-campaign path ref copies only the named asset in create", async () => {
    const { slug, campaignId, third } = await seedSourceWithThird(unique("src"), "path");
    const snapshot = await counts(harness.db);
    const { copy, free, deleteAssets } = watch();

    const res = await createFrom(ONLY_T1, { name: unique("copy"), source: campaignId });
    expect(res.status).toBe(201);
    const { slug: newSlug, campaignId: newUuid } = (await res.json()) as {
      campaignId: string;
      slug: string;
      revision: string;
    };

    expect((await assetRows(newUuid)).sort()).toEqual(["alt.png", "extra.png", "logo.png"]);
    expect((await keysOf(newSlug)).length).toBe(3);
    expect(copy).toHaveBeenCalledWith(slug, newSlug);
    expect(copy).toHaveBeenCalledWith(third.slug, newSlug, { only: ["alt.png"] });
    const stored = (await ownerStore.findBriefById(newSlug))!.brief;
    const logoRef = stored.products[0].logoPath;
    expect((await store().assetOwner(logoRef))?.slug).toBe(newSlug);
    expect(free).not.toHaveBeenCalled();
    expect(deleteAssets).not.toHaveBeenCalled();

    expect((await assetRows(newUuid)).some((n) => n === "bg.png")).toBe(false);
    await expectSourcesUntouched(
      { slug: slug, rows: ["extra.png", "logo.png"], objects: 2 },
      { slug: third.slug, rows: ["alt.png", "bg.png", "logo.png"], objects: 3 },
    );
    expect((await counts(harness.db)).versions).toBe(snapshot.versions + 1);
  });

  test("s3, a third-campaign path ref copies only the named asset in duplicate", async () => {
    const { slug, campaignId, third } = await seedSourceWithThird(unique("src"), "path");
    const snapshot = await counts(harness.db);
    const { copy, free, deleteAssets } = watch();

    const res = await duplicate(ONLY_T1, campaignId, unique("copy"));
    expect(res.status).toBe(201);
    const newSlug = (await res.json()).brief.id as string;
    const newUuid = await uuidOf(newSlug);

    expect((await assetRows(newUuid)).sort()).toEqual(["alt.png", "extra.png", "logo.png"]);
    expect((await keysOf(newSlug)).length).toBe(3);
    expect(copy).toHaveBeenCalledWith(slug, newSlug);
    expect(copy).toHaveBeenCalledWith(third.slug, newSlug, { only: ["alt.png"] });
    const stored = (await ownerStore.findBriefById(newSlug))!.brief;
    const logoRef = stored.products[0].logoPath;
    expect((await store().assetOwner(logoRef))?.slug).toBe(newSlug);
    expect(free).not.toHaveBeenCalled();
    expect(deleteAssets).not.toHaveBeenCalled();

    expect((await assetRows(newUuid)).some((n) => n === "bg.png")).toBe(false);
    await expectSourcesUntouched(
      { slug: slug, rows: ["extra.png", "logo.png"], objects: 2 },
      { slug: third.slug, rows: ["alt.png", "bg.png", "logo.png"], objects: 3 },
    );
    expect((await counts(harness.db)).versions).toBe(snapshot.versions + 1);
  });

  test("s3, a brief naming two different third campaigns copies only the named asset of each", async () => {
    const thirdSlug = unique("third");
    const secondThirdSlug = unique("third");
    await ownerStore.createCampaign(thirdSlug, { teamId: "t1" });
    await ownerStore.createCampaign(secondThirdSlug, { teamId: "t1" });
    const t1AltId = await upload(OWNER, thirdSlug, "alt.png", PNG_ALT2);
    await upload(OWNER, thirdSlug, "logo.png", PNG_THIRD);
    await upload(OWNER, thirdSlug, "bg.png", PNG_ALT3);
    const t2markId = await upload(OWNER, secondThirdSlug, "mark.png", PNG_MARK);
    await upload(OWNER, secondThirdSlug, "logo.png", PNG_ALT4);
    await upload(OWNER, secondThirdSlug, "bg.png", PNG_ALT);

    const slug = unique("src");
    const { campaignId } = await ownerStore.createCampaign(slug, { teamId: "t1" });
    await upload(OWNER, slug, "logo.png", PNG);
    await upload(OWNER, slug, "extra.png", PNG_ALT);
    const snapshot = await counts(harness.db);
    const { copy, free, deleteAssets } = watch();
    await ownerStore.createBrief(
      {
        ...baseBrief(slug, pathRef(slug)),
        products: [
          { id: "p1", name: "P1", primaryColor: "#1473E3", logoPath: t1AltId },
          { id: "p2", name: "P2", primaryColor: "#1473E3", logoPath: t2markId },
        ],
      },
      { teamId: "t1" },
    );

    const cRes = await createFrom(ONLY_T1, { name: unique("copy"), source: campaignId });
    expect(cRes.status).toBe(201);
    const { slug: cNew, campaignId: cUuid } = (await cRes.json()) as {
      campaignId: string;
      slug: string;
      revision: string;
    };
    expect((await assetRows(cUuid)).sort()).toEqual([
      "alt.png",
      "extra.png",
      "logo.png",
      "mark.png",
    ]);
    expect(copy).toHaveBeenCalledWith(thirdSlug, cNew, { only: ["alt.png"] });
    expect(copy).toHaveBeenCalledWith(secondThirdSlug, cNew, { only: ["mark.png"] });
    expect(free).not.toHaveBeenCalled();
    expect(deleteAssets).not.toHaveBeenCalled();
    await expectSourcesUntouched(
      { slug: slug, rows: ["extra.png", "logo.png"], objects: 2 },
      { slug: thirdSlug, rows: ["alt.png", "bg.png", "logo.png"], objects: 3 },
      { slug: secondThirdSlug, rows: ["bg.png", "logo.png", "mark.png"], objects: 3 },
    );

    const dRes = await duplicate(ONLY_T1, campaignId, unique("copy"));
    expect(dRes.status).toBe(201);
    const dNew = (await dRes.json()).brief.id as string;
    const dUuid = await uuidOf(dNew);
    expect((await assetRows(dUuid)).sort()).toEqual([
      "alt.png",
      "extra.png",
      "logo.png",
      "mark.png",
    ]);
    expect(copy).toHaveBeenCalledWith(thirdSlug, dNew, { only: ["alt.png"] });
    expect(copy).toHaveBeenCalledWith(secondThirdSlug, dNew, { only: ["mark.png"] });
    await expectSourcesUntouched(
      { slug: slug, rows: ["extra.png", "logo.png"], objects: 2 },
      { slug: thirdSlug, rows: ["alt.png", "bg.png", "logo.png"], objects: 3 },
      { slug: secondThirdSlug, rows: ["bg.png", "logo.png", "mark.png"], objects: 3 },
    );
    expect((await counts(harness.db)).campaigns).toBe(snapshot.campaigns + 2);
  });

  test("s3, a third-campaign ref carried in inputAsset is copied narrowly in create", async () => {
    const thirdSlug = unique("third");
    await ownerStore.createCampaign(thirdSlug, { teamId: "t1" });
    const altId = await upload(OWNER, thirdSlug, "alt.png", PNG_ALT2);
    await upload(OWNER, thirdSlug, "logo.png", PNG_THIRD);
    await upload(OWNER, thirdSlug, "bg.png", PNG_ALT3);
    const slug = unique("src");
    const { campaignId } = await ownerStore.createCampaign(slug, { teamId: "t1" });
    const sourceLogoId = await upload(OWNER, slug, "logo.png", PNG);
    await upload(OWNER, slug, "extra.png", PNG_ALT);
    await ownerStore.createBrief(
      {
        ...baseBrief(slug, pathRef(slug)),
        products: [
          {
            id: "p1",
            name: "P1",
            primaryColor: "#1473E3",
            logoPath: sourceLogoId,
            inputAsset: altId,
          },
        ],
      },
      { teamId: "t1" },
    );
    const { copy, free, deleteAssets } = watch();

    const res = await createFrom(ONLY_T1, { name: unique("copy"), source: campaignId });
    expect(res.status).toBe(201);
    const { slug: newSlug, campaignId: newUuid } = (await res.json()) as {
      campaignId: string;
      slug: string;
      revision: string;
    };
    expect((await assetRows(newUuid)).sort()).toEqual(["alt.png", "extra.png", "logo.png"]);
    expect(copy).toHaveBeenCalledWith(thirdSlug, newSlug, { only: ["alt.png"] });
    const stored = (await ownerStore.findBriefById(newSlug))!.brief;
    expect((await store().assetOwner(stored.products[0].inputAsset!))?.slug).toBe(newSlug);
    expect((await assetRows(newUuid)).some((n) => n === "bg.png")).toBe(false);
    expect(free).not.toHaveBeenCalled();
    expect(deleteAssets).not.toHaveBeenCalled();
    await expectSourcesUntouched(
      { slug: slug, rows: ["extra.png", "logo.png"], objects: 2 },
      { slug: thirdSlug, rows: ["alt.png", "bg.png", "logo.png"], objects: 3 },
    );
  });

  test("s3, a third-campaign ref carried in inputAsset is copied narrowly in duplicate", async () => {
    const thirdSlug = unique("third");
    await ownerStore.createCampaign(thirdSlug, { teamId: "t1" });
    const altId = await upload(OWNER, thirdSlug, "alt.png", PNG_ALT2);
    await upload(OWNER, thirdSlug, "logo.png", PNG_THIRD);
    await upload(OWNER, thirdSlug, "bg.png", PNG_ALT3);
    const slug = unique("src");
    const { campaignId } = await ownerStore.createCampaign(slug, { teamId: "t1" });
    const sourceLogoId = await upload(OWNER, slug, "logo.png", PNG);
    await upload(OWNER, slug, "extra.png", PNG_ALT);
    await ownerStore.createBrief(
      {
        ...baseBrief(slug, pathRef(slug)),
        products: [
          {
            id: "p1",
            name: "P1",
            primaryColor: "#1473E3",
            logoPath: sourceLogoId,
            inputAsset: altId,
          },
        ],
      },
      { teamId: "t1" },
    );
    const { copy, free, deleteAssets } = watch();

    const res = await duplicate(ONLY_T1, campaignId, unique("copy"));
    expect(res.status).toBe(201);
    const newSlug = (await res.json()).brief.id as string;
    const newUuid = await uuidOf(newSlug);
    expect((await assetRows(newUuid)).sort()).toEqual(["alt.png", "extra.png", "logo.png"]);
    expect(copy).toHaveBeenCalledWith(thirdSlug, newSlug, { only: ["alt.png"] });
    const stored = (await ownerStore.findBriefById(newSlug))!.brief;
    expect((await store().assetOwner(stored.products[0].inputAsset!))?.slug).toBe(newSlug);
    expect((await assetRows(newUuid)).some((n) => n === "bg.png")).toBe(false);
    expect(free).not.toHaveBeenCalled();
    expect(deleteAssets).not.toHaveBeenCalled();
    await expectSourcesUntouched(
      { slug: slug, rows: ["extra.png", "logo.png"], objects: 2 },
      { slug: thirdSlug, rows: ["alt.png", "bg.png", "logo.png"], objects: 3 },
    );
  });

  test("s3, the unreferenced third-campaign assets are not copied and the third is untouched after both routes", async () => {
    const { campaignId, third } = await seedSourceWithThird(unique("both"));
    const snapshot = await counts(harness.db);

    const cRes = await createFrom(ONLY_T1, { name: unique("copy"), source: campaignId });
    expect(cRes.status).toBe(201);
    const cNew = (await cRes.json()).slug as string;
    const dRes = await duplicate(ONLY_T1, campaignId, unique("copy"));
    expect(dRes.status).toBe(201);
    const dNew = (await dRes.json()).brief.id as string;

    const cUuid = await uuidOf(cNew);
    const dUuid = await uuidOf(dNew);
    // No bg.png reached either new campaign.
    expect((await assetRows(cUuid)).sort()).toEqual(["alt.png", "extra.png", "logo.png"]);
    expect((await assetRows(dUuid)).sort()).toEqual(["alt.png", "extra.png", "logo.png"]);
    // T itself is untouched by both routes.
    await expectSourcesUntouched({
      slug: third.slug,
      rows: ["alt.png", "bg.png", "logo.png"],
      objects: 3,
    });
    expect((await counts(harness.db)).campaigns).toBe(snapshot.campaigns + 2);
  });

  test("s3, a hidden third campaign is refused by create and duplicate", async () => {
    const { slug, campaignId, third } = await seedSourceWithThird(unique("hid"));
    await preHide(third.slug);
    const snapshot = await counts(harness.db);

    const cRes = await createFrom(ONLY_T1, { name: unique("copy"), source: campaignId });
    expect(cRes.status).toBe(404);
    const cBody = (await cRes.json()) as { error: string };
    expect(cBody).toEqual({ error: `Brief "${campaignId}" not found.` });
    expect(cBody.error).not.toContain(third.slug);

    const dRes = await duplicate(ONLY_T1, slug, unique("copy"));
    expect(dRes.status).toBe(404);
    const dBody = (await dRes.json()) as { error: string };
    expect(dBody).toEqual({ error: `Brief "${slug}" not found.` });
    expect(dBody.error).not.toContain(third.slug);

    // No campaign, asset row, or object was added.
    expect(await counts(harness.db)).toEqual(snapshot);
  });

  test("s3, a failure after the narrowed copy frees only what this request created", async () => {
    const { slug, campaignId, third } = await seedSourceWithThird(unique("fail"));
    const snapshot = await counts(harness.db);
    const { seen, createdByTarget, free, deleteAssets } = watch();
    const createBriefSpy = vi
      .spyOn(PgBriefStore.prototype, "createBrief")
      .mockRejectedValueOnce(new Error("boom"));

    // Create fails: only the source's and the third's NAMED copies were created, so the
    // union freed is S's 2 + T's 1 (T's set has size 1, not 3).
    const cRes = await createFrom(ONLY_T1, { name: unique("copy"), source: campaignId });
    expect(cRes.status).toBe(500);
    const mCreate = (await mint.mock.results[0]!.value) as { campaignId: string; slug: string };
    expect(seen.get(third.slug)!.size).toBe(1);
    expect(free).toHaveBeenCalledTimes(1);
    expect(free.mock.calls[0]![0]).toBe(mCreate.slug);
    expect([...(free.mock.calls[0]![1] as readonly string[])].sort()).toEqual(
      [...createdByTarget.get(mCreate.slug)!].sort(),
    );
    expect([...createdByTarget.get(mCreate.slug)!].sort()).toHaveLength(3);
    expect(deleteAssets).not.toHaveBeenCalled();
    expect(await objectStore.list(inputPrefix("local", mCreate.campaignId))).toEqual([]);
    // Re-arm the one-time rejection for the duplicate half.
    createBriefSpy.mockRejectedValueOnce(new Error("boom"));

    // Duplicate fails the same way, freeing this request's own minted union.
    const dRes = await duplicate(ONLY_T1, campaignId, unique("copy"));
    expect(dRes.status).toBe(500);
    const mDup = (await mint.mock.results[1]!.value) as { campaignId: string; slug: string };
    expect(free).toHaveBeenCalledTimes(2);
    expect(free.mock.calls[1]![0]).toBe(mDup.slug);
    expect([...(free.mock.calls[1]![1] as readonly string[])].sort()).toEqual(
      [...createdByTarget.get(mDup.slug)!].sort(),
    );
    expect(deleteAssets).not.toHaveBeenCalled();
    expect(await objectStore.list(inputPrefix("local", mDup.campaignId))).toEqual([]);

    // Both routes rolled back: S and T keep everything, global counts are intact.
    await expectSourcesUntouched(
      { slug: slug, rows: ["extra.png", "logo.png"], objects: 2 },
      { slug: third.slug, rows: ["alt.png", "bg.png", "logo.png"], objects: 3 },
    );
    expect(await counts(harness.db)).toEqual(snapshot);
  });

  test("s3, a third-campaign copy that deduplicates by sha is not freed", async () => {
    // S carries an `alt.png` of the SAME bytes as T's referenced `alt.png`, so the
    // narrowed third copy finds it already in the new campaign (name+sha match) and
    // reuses it: T mints nothing, and nothing of T is freed on a later failure.
    const thirdSlug = unique("third");
    await ownerStore.createCampaign(thirdSlug, { teamId: "t1" });
    const altId = await upload(OWNER, thirdSlug, "alt.png", PNG_ALT2);
    await upload(OWNER, thirdSlug, "bg.png", PNG_ALT3);
    await upload(OWNER, thirdSlug, "logo.png", PNG_THIRD);
    const slug = unique("src");
    const { campaignId } = await ownerStore.createCampaign(slug, { teamId: "t1" });
    await upload(OWNER, slug, "logo.png", PNG);
    await upload(OWNER, slug, "extra.png", PNG_ALT);
    await upload(OWNER, slug, "alt.png", PNG_ALT2);
    await ownerStore.createBrief(
      {
        ...baseBrief(slug, pathRef(slug)),
        products: [{ id: "p1", name: "P1", primaryColor: "#1473E3", logoPath: altId }],
      },
      { teamId: "t1" },
    );
    const snapshot = await counts(harness.db);

    watch();
    vi.spyOn(PgBriefStore.prototype, "createBrief").mockRejectedValueOnce(new Error("boom"));
    const res = await createFrom(ONLY_T1, { name: unique("copy"), source: campaignId });
    expect(res.status).toBe(500);
    const m = await minted();

    // T's copy created nothing (sha-dedup), so nothing of T can be freed.
    expect(seen.get(thirdSlug)!.size).toBe(0);
    expect(free).toHaveBeenCalledTimes(1);
    expect(free.mock.calls[0]![0]).toBe(m.slug);
    expect([...(free.mock.calls[0]![1] as readonly string[])].sort()).toEqual(
      [...createdByTarget.get(m.slug)!].sort(),
    );
    expect(await objectStore.list(inputPrefix("local", m.campaignId))).toEqual([]);
    await expectSourcesUntouched(
      { slug: slug, rows: ["alt.png", "extra.png", "logo.png"], objects: 3 },
      { slug: thirdSlug, rows: ["alt.png", "bg.png", "logo.png"], objects: 3 },
    );
    expect((await counts(harness.db)).campaigns).toEqual(snapshot.campaigns);
  });

  test("s3, the source stays whole, Q8 regression pin", async () => {
    const { campaignId } = await seedSourceWithThird(unique("q8"));
    watch();

    const cRes = await createFrom(ONLY_T1, { name: unique("copy"), source: campaignId });
    expect(cRes.status).toBe(201);
    const cNew = (await cRes.json()).slug as string;
    const cUuid = await uuidOf(cNew);

    const dRes = await duplicate(ONLY_T1, campaignId, unique("copy"));
    expect(dRes.status).toBe(201);
    const dNew = (await dRes.json()).brief.id as string;
    const dUuid = await uuidOf(dNew);

    // Q8: the SOURCE's own whole library is copied — extra.png, which no ref names,
    // survives in the new campaign after both routes.
    expect((await assetRows(cUuid)).sort()).toEqual(["alt.png", "extra.png", "logo.png"]);
    expect((await assetRows(dUuid)).sort()).toEqual(["alt.png", "extra.png", "logo.png"]);
  });
});

/** The create/replace path-shape on pg plus fs: refs are paths, teams gate the THIRD source. */
describe("copy third-campaign-only on pg plus fs", () => {
  const SAVED_OBJECT_STORE = process.env.OBJECT_STORE;
  const SAVED_BACKEND = process.env.STORE_BACKEND;
  const ORIG_ROOT = process.env.PROJECT_ROOT;
  let harness: PgHarness;
  let ownerStore: PgBriefStore;

  let seq = 0;
  const unique = (prefix: string): string => `${prefix}-${(seq += 1)}`;

  const store = () => getAssetStore(ONLY_T1);

  const minted = async () =>
    (await mint.mock.results[0]!.value) as { campaignId: string; slug: string };

  let mint: ReturnType<typeof vi.spyOn>;
  let seen: Map<string, ReadonlySet<string>>;
  let createdByTarget: Map<string, string[]>;
  let free: ReturnType<typeof vi.spyOn>;
  let copy: ReturnType<typeof vi.spyOn>;
  let deleteAssets: ReturnType<typeof vi.spyOn>;

  const watchFs = () => {
    seen = new Map();
    createdByTarget = new Map();
    mint = vi.spyOn(PgBriefStore.prototype, "createCampaign");
    const real = FsAssetStore.prototype.copyAssets;
    copy = vi.spyOn(FsAssetStore.prototype, "copyAssets").mockImplementation(async function (
      this: FsAssetStore,
      from: string,
      to: string,
      options?: CopyAssetsOptions,
    ) {
      const result = await real.call(this, from, to, options);
      if (!seen.has(from)) seen.set(from, new Set(result.created));
      const arr = createdByTarget.get(to) ?? [];
      for (const id of result.created) arr.push(id);
      createdByTarget.set(to, arr);
      return result;
    });
    free = vi.spyOn(FsAssetStore.prototype, "freeUnreferencedAssets");
    deleteAssets = vi.spyOn(FsAssetStore.prototype, "deleteAssets");
    return { mint, seen, createdByTarget, free, copy, deleteAssets };
  };

  const filesOf = (slug: string): string[] => {
    const dir = join(harness.projectRoot, "assets", "inputs", slug);
    return existsSync(dir)
      ? (readdirSync(dir, { recursive: true }) as string[]).slice().sort()
      : [];
  };

  const namesOf = async (briefId: string): Promise<string[]> =>
    (await store().listAssets(briefId)).map((a) => a.name);

  const preHide = async (slug: string): Promise<void> => {
    await harness.db.query(
      `update campaign set team_id = 't2' where org_id = 'local' and slug = $1`,
      [slug],
    );
  };

  /** S: logo.png=PNG, extra.png=PNG_ALT. T: logo.png=PNG_THIRD, alt.png=PNG_ALT2, bg.png=PNG_ALT3.
   * S's stored brief names `assets/inputs/<T>/alt.png`, so only alt.png is carried from T. */
  const seedSourceWithThird = async (
    prefix: string,
  ): Promise<{
    slug: string;
    campaignId: string;
    third: { slug: string; campaignId: string };
  }> => {
    const thirdSlug = unique("third");
    const { campaignId: thirdId } = await ownerStore.createCampaign(thirdSlug, {
      teamId: "t1",
    });
    await store().writeAsset(thirdSlug, "logo.png", PNG_THIRD);
    await store().writeAsset(thirdSlug, "alt.png", PNG_ALT2);
    await store().writeAsset(thirdSlug, "bg.png", PNG_ALT3);
    const slug = unique(prefix);
    const { campaignId } = await ownerStore.createCampaign(slug, { teamId: "t1" });
    await store().writeAsset(slug, "logo.png", PNG);
    await store().writeAsset(slug, "extra.png", PNG_ALT);
    await ownerStore.createBrief(
      {
        ...baseBrief(slug, pathRef(slug)),
        products: [
          {
            id: "p1",
            name: "P1",
            primaryColor: "#1473E3",
            logoPath: `assets/inputs/${thirdSlug}/alt.png`,
          },
        ],
      },
      { teamId: "t1" },
    );
    return { slug, campaignId, third: { slug: thirdSlug, campaignId: thirdId } };
  };

  beforeAll(async () => {
    setCapabilities({ motion: true });
    delete process.env.OBJECT_STORE;
    harness = await setupPgHarness();
    resetAssetStore();
    ownerStore = new PgBriefStore(harness.db, "local", "owner", ["owner"], []);
    await harness.db.query(
      `insert into team (id, name, "memberCount", org_id, created_at) values
         ($1, $2, 0, $3, now()), ($4, $5, 0, $3, now())`,
      ["t1", "Team One", "local", "t2", "Team Two"],
    );
  });

  afterEach(() => {
    resetAssetStore();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    setCapabilities({ motion: false, reason: "not probed" });
    resetAssetStore();
    if (SAVED_OBJECT_STORE === undefined) delete process.env.OBJECT_STORE;
    else process.env.OBJECT_STORE = SAVED_OBJECT_STORE;
    if (SAVED_BACKEND === undefined) delete process.env.STORE_BACKEND;
    else process.env.STORE_BACKEND = SAVED_BACKEND;
    if (ORIG_ROOT === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = ORIG_ROOT;
    await harness.cleanup();
  });

  test("pg plus fs, create and duplicate copy only the named third file", async () => {
    const { slug, campaignId, third } = await seedSourceWithThird(unique("src"));
    watchFs();

    const cRes = await createFrom(ONLY_T1, { name: unique("copy"), source: campaignId });
    expect(cRes.status).toBe(201);
    const cNew = (await cRes.json()).slug as string;
    expect((await namesOf(cNew)).sort()).toEqual(["alt.png", "extra.png", "logo.png"]);
    const cStored = (await ownerStore.findBriefById(cNew))!.brief;
    expect(cStored.products[0].logoPath).toBe(`assets/inputs/${cNew}/alt.png`);
    expect(copy).toHaveBeenCalledWith(third.slug, cNew, { only: ["alt.png"] });

    const dRes = await duplicate(ONLY_T1, campaignId, unique("copy"));
    expect(dRes.status).toBe(201);
    const dNew = (await dRes.json()).brief.id as string;
    expect((await namesOf(dNew)).sort()).toEqual(["alt.png", "extra.png", "logo.png"]);
    const dStored = (await ownerStore.findBriefById(dNew))!.brief;
    expect(dStored.products[0].logoPath).toBe(`assets/inputs/${dNew}/alt.png`);

    // T is untouched by either route.
    expect((await namesOf(third.slug)).sort()).toEqual(["alt.png", "bg.png", "logo.png"]);
    expect((await filesOf(slug)).sort()).toEqual(["extra.png", "logo.png"]);
  });

  test("pg plus fs, a hidden third campaign is refused by create and duplicate", async () => {
    const { campaignId, third } = await seedSourceWithThird(unique("hid"));
    const snapshot = await counts(harness.db);
    await preHide(third.slug);

    const cRes = await createFrom(ONLY_T1, { name: unique("copy"), source: campaignId });
    expect(cRes.status).toBe(404);
    expect(await cRes.json()).toEqual({ error: `Brief "${third.slug}" not found.` });

    const dRes = await duplicate(ONLY_T1, campaignId, unique("copy"));
    expect(dRes.status).toBe(404);
    expect(await dRes.json()).toEqual({ error: `Brief "${third.slug}" not found.` });

    expect(await counts(harness.db)).toEqual(snapshot);
  });

  test("pg plus fs, a failure after the narrowed copy frees only the files it wrote", async () => {
    const { slug, campaignId, third } = await seedSourceWithThird(unique("fail"));
    const snapshot = await counts(harness.db);
    watchFs();
    vi.spyOn(PgBriefStore.prototype, "createBrief").mockRejectedValueOnce(new Error("boom"));

    const res = await createFrom(ONLY_T1, { name: unique("copy"), source: campaignId });
    expect(res.status).toBe(500);
    const m = await minted();
    expect(filesOf(m.slug)).toEqual([]);
    expect(filesOf(third.slug).sort()).toEqual(["alt.png", "bg.png", "logo.png"]);
    expect(filesOf(slug).sort()).toEqual(["extra.png", "logo.png"]);
    expect(free).toHaveBeenCalledTimes(1);
    expect(free.mock.calls[0]![0]).toBe(m.slug);
    expect([...(free.mock.calls[0]![1] as readonly string[])].sort()).toEqual(
      [...createdByTarget.get(m.slug)!].sort(),
    );
    expect(deleteAssets).not.toHaveBeenCalled();
    expect((await counts(harness.db)).campaigns).toEqual(snapshot.campaigns);
  });

  test("pg plus fs, a duplicate failure after the narrowed copy frees only the files it wrote", async () => {
    const { slug, campaignId, third } = await seedSourceWithThird(unique("fail"));
    const snapshot = await counts(harness.db);
    watchFs();
    vi.spyOn(PgBriefStore.prototype, "createBrief").mockRejectedValueOnce(new Error("boom"));

    const res = await duplicate(ONLY_T1, campaignId, unique("copy"));
    expect(res.status).toBe(500);
    const m = await minted();
    expect(filesOf(m.slug)).toEqual([]);
    expect(filesOf(third.slug).sort()).toEqual(["alt.png", "bg.png", "logo.png"]);
    expect(filesOf(slug).sort()).toEqual(["extra.png", "logo.png"]);
    expect(free).toHaveBeenCalledTimes(1);
    expect(free.mock.calls[0]![0]).toBe(m.slug);
    expect([...(free.mock.calls[0]![1] as readonly string[])].sort()).toEqual(
      [...createdByTarget.get(m.slug)!].sort(),
    );
    expect(deleteAssets).not.toHaveBeenCalled();
    expect((await counts(harness.db)).campaigns).toEqual(snapshot.campaigns);
  });

  test("pg plus fs, a nested third-campaign path ref and a doubled slash name the right files", async () => {
    // T holds a nested file; a path ref names it and keeps its nested path, and a doubled
    // slash still names its base file (the #716 slash-strip follow-up).
    const thirdSlug = unique("third");
    await ownerStore.createCampaign(thirdSlug, { teamId: "t1" });
    await store().writeAsset(thirdSlug, "logo.png", PNG_THIRD);
    await store().writeAsset(thirdSlug, "alt.png", PNG_ALT2);
    await store().writeAsset(thirdSlug, "bg.png", PNG_ALT3);
    await store().writeAsset(thirdSlug, "sub/dir/n.png", NESTED);

    const slug = unique("src");
    const { campaignId } = await ownerStore.createCampaign(slug, { teamId: "t1" });
    await store().writeAsset(slug, "logo.png", PNG);
    await store().writeAsset(slug, "extra.png", PNG_ALT);
    await ownerStore.createBrief(
      {
        ...baseBrief(slug, pathRef(slug)),
        products: [
          {
            id: "p1",
            name: "P1",
            primaryColor: "#1473E3",
            logoPath: `assets/inputs/${thirdSlug}/sub/dir/n.png`,
          },
        ],
      },
      { teamId: "t1" },
    );

    const res = await createFrom(ONLY_T1, { name: unique("copy"), source: campaignId });
    expect(res.status).toBe(201);
    const newSlug = (await res.json()).slug as string;
    // The nested third file reaches the new campaign under its nested path.
    expect(await store().readAsset(newSlug, "sub/dir/n.png")).toEqual(NESTED);
    expect(await store().readAsset(newSlug, "logo.png")).toEqual(PNG);
    expect(await store().readAsset(newSlug, "extra.png")).toEqual(PNG_ALT);
    expect((await namesOf(newSlug)).sort()).toEqual(["extra.png", "logo.png"]);
    const stored = (await ownerStore.findBriefById(newSlug))!.brief;
    expect(stored.products[0].logoPath).toBe(`assets/inputs/${newSlug}/sub/dir/n.png`);
    expect(await store().readAsset(thirdSlug, "sub/dir/n.png")).toEqual(NESTED);
    expect((await namesOf(thirdSlug)).sort()).toEqual(["alt.png", "bg.png", "logo.png"]);

    // Doubled-slash ref still names alt.png.
    const slug2 = unique("src");
    const { campaignId: campaignId2 } = await ownerStore.createCampaign(slug2, { teamId: "t1" });
    await store().writeAsset(slug2, "logo.png", PNG);
    await store().writeAsset(slug2, "extra.png", PNG_ALT);
    await ownerStore.createBrief(
      {
        ...baseBrief(slug2, pathRef(slug2)),
        products: [
          {
            id: "p1",
            name: "P1",
            primaryColor: "#1473E3",
            logoPath: `assets/inputs/${thirdSlug}//alt.png`,
          },
        ],
      },
      { teamId: "t1" },
    );
    const res2 = await createFrom(ONLY_T1, { name: unique("copy"), source: campaignId2 });
    expect(res2.status).toBe(201);
    const newSlug2 = (await res2.json()).slug as string;
    expect(filesOf(newSlug2).sort()).toEqual(["alt.png", "extra.png", "logo.png"]);
  });
});

/** The create/replace path-shape on fs only: no teams, files live under `assets/inputs/<slug>/`. */
describe("copy third-campaign-only on fs only", () => {
  const ORIG_ROOT = process.env.PROJECT_ROOT;
  const SAVED_BACKEND = process.env.STORE_BACKEND;
  const SAVED_OBJECT_STORE = process.env.OBJECT_STORE;
  let harness: FsHarness;

  let seq = 0;
  const unique = (prefix: string): string => `${prefix}-${(seq += 1)}`;

  const minted = async () =>
    (await mint.mock.results[0]!.value) as { campaignId: string; slug: string };

  let mint: ReturnType<typeof vi.spyOn>;
  let seen: Map<string, ReadonlySet<string>>;
  let createdByTarget: Map<string, string[]>;
  let free: ReturnType<typeof vi.spyOn>;
  let copy: ReturnType<typeof vi.spyOn>;
  let deleteAssets: ReturnType<typeof vi.spyOn>;

  const watchFs = () => {
    seen = new Map();
    createdByTarget = new Map();
    mint = vi.spyOn(FsBriefStore.prototype, "createCampaign");
    const real = FsAssetStore.prototype.copyAssets;
    copy = vi.spyOn(FsAssetStore.prototype, "copyAssets").mockImplementation(async function (
      this: FsAssetStore,
      from: string,
      to: string,
      options?: CopyAssetsOptions,
    ) {
      const result = await real.call(this, from, to, options);
      if (!seen.has(from)) seen.set(from, new Set(result.created));
      const arr = createdByTarget.get(to) ?? [];
      for (const id of result.created) arr.push(id);
      createdByTarget.set(to, arr);
      return result;
    });
    free = vi.spyOn(FsAssetStore.prototype, "freeUnreferencedAssets");
    deleteAssets = vi.spyOn(FsAssetStore.prototype, "deleteAssets");
    return { mint, seen, createdByTarget, free, copy, deleteAssets };
  };

  const filesOf = (slug: string): string[] => {
    const dir = join(harness.projectRoot, "assets", "inputs", slug);
    return existsSync(dir)
      ? (readdirSync(dir, { recursive: true }) as string[]).slice().sort()
      : [];
  };

  beforeAll(() => {
    setCapabilities({ motion: true });
    harness = setupFsHarness();
    delete process.env.OBJECT_STORE;
    resetAssetStore();
  });

  afterEach(() => {
    resetAssetStore();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    setCapabilities({ motion: false, reason: "not probed" });
    resetAssetStore();
    if (SAVED_OBJECT_STORE === undefined) delete process.env.OBJECT_STORE;
    else process.env.OBJECT_STORE = SAVED_OBJECT_STORE;
    if (SAVED_BACKEND === undefined) delete process.env.STORE_BACKEND;
    else process.env.STORE_BACKEND = SAVED_BACKEND;
    if (ORIG_ROOT === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = ORIG_ROOT;
    harness.cleanup();
  });

  /** S: logo.png=PNG, extra.png=PNG_ALT. T: logo.png=PNG_THIRD, alt.png=PNG_ALT2, bg.png=PNG_ALT3.
   * S's brief names `assets/inputs/<T>/alt.png`, so only alt.png is carried from T. */
  const seedSourceWithThird = async (
    prefix: string,
  ): Promise<{
    slug: string;
    third: { slug: string };
  }> => {
    const briefStore = getBriefStore(LOCAL_TENANT);
    const assetStore = getAssetStore(LOCAL_TENANT);
    const thirdSlug = unique("third");
    await briefStore.createCampaign(thirdSlug);
    await assetStore.writeAsset(thirdSlug, "logo.png", PNG_THIRD);
    await assetStore.writeAsset(thirdSlug, "alt.png", PNG_ALT2);
    await assetStore.writeAsset(thirdSlug, "bg.png", PNG_ALT3);
    const slug = unique(prefix);
    await briefStore.createCampaign(slug);
    await assetStore.writeAsset(slug, "logo.png", PNG);
    await assetStore.writeAsset(slug, "extra.png", PNG_ALT);
    await briefStore.createBrief({
      ...baseBrief(slug, pathRef(slug)),
      products: [
        {
          id: "p1",
          name: "P1",
          primaryColor: "#1473E3",
          logoPath: `assets/inputs/${thirdSlug}/alt.png`,
        },
      ],
    });
    return { slug, third: { slug: thirdSlug } };
  };

  test("fs only, create and duplicate copy only the named third file and a failure frees nothing", async () => {
    const { slug, third } = await seedSourceWithThird(unique("src"));

    const cRes = await createFrom(LOCAL_TENANT, { name: unique("copy"), source: slug });
    expect(cRes.status).toBe(201);
    const cNew = (await cRes.json()).slug as string;
    expect(filesOf(cNew).sort()).toEqual(["alt.png", "extra.png", "logo.png"]);
    expect(
      (await getBriefStore(LOCAL_TENANT).findBriefById(cNew))!.brief.products[0].logoPath,
    ).toBe(`assets/inputs/${cNew}/alt.png`);

    const dRes = await duplicate(LOCAL_TENANT, slug, unique("copy"));
    expect(dRes.status).toBe(201);
    const dNew = (await dRes.json()).brief.id as string;
    expect(filesOf(dNew).sort()).toEqual(["alt.png", "extra.png", "logo.png"]);
    expect(
      (await getBriefStore(LOCAL_TENANT).findBriefById(dNew))!.brief.products[0].logoPath,
    ).toBe(`assets/inputs/${dNew}/alt.png`);

    // T and S untouched by either route.
    expect(filesOf(third.slug).sort()).toEqual(["alt.png", "bg.png", "logo.png"]);
    expect(filesOf(slug).sort()).toEqual(["extra.png", "logo.png"]);

    // A failure after the narrowed copy frees only what this request created and makes
    // no visibility call (fs has no teams).
    watchFs();
    vi.spyOn(FsBriefStore.prototype, "createBrief").mockRejectedValueOnce(new Error("boom"));
    const visibility = vi.spyOn(FsBriefStore.prototype, "campaignVisibility");
    const res = await createFrom(LOCAL_TENANT, { name: unique("fail"), source: slug });
    expect(res.status).toBe(500);
    const m = await minted();
    expect(visibility).not.toHaveBeenCalled();
    expect(free).toHaveBeenCalledTimes(1);
    expect(free.mock.calls[0]![0]).toBe(m.slug);
    expect([...(free.mock.calls[0]![1] as readonly string[])].sort()).toEqual(
      [...createdByTarget.get(m.slug)!].sort(),
    );
    expect(deleteAssets).not.toHaveBeenCalled();
    expect(filesOf(m.slug)).toEqual([]);
    expect(filesOf(third.slug).sort()).toEqual(["alt.png", "bg.png", "logo.png"]);
    expect(filesOf(slug).sort()).toEqual(["extra.png", "logo.png"]);
  });

  test("fs only, a duplicate failure after the narrowed copy frees only what it wrote and makes no visibility call", async () => {
    const { slug, third } = await seedSourceWithThird(unique("src"));
    watchFs();
    vi.spyOn(FsBriefStore.prototype, "createBrief").mockRejectedValueOnce(new Error("boom"));
    const visibility = vi.spyOn(FsBriefStore.prototype, "campaignVisibility");

    const res = await duplicate(LOCAL_TENANT, slug, unique("fail"));
    expect(res.status).toBe(500);
    const m = await minted();
    expect(visibility).not.toHaveBeenCalled();
    expect(free).toHaveBeenCalledTimes(1);
    expect(free.mock.calls[0]![0]).toBe(m.slug);
    expect([...(free.mock.calls[0]![1] as readonly string[])].sort()).toEqual(
      [...createdByTarget.get(m.slug)!].sort(),
    );
    expect(deleteAssets).not.toHaveBeenCalled();
    expect(filesOf(m.slug)).toEqual([]);
    expect(filesOf(third.slug).sort()).toEqual(["alt.png", "bg.png", "logo.png"]);
    expect(filesOf(slug).sort()).toEqual(["extra.png", "logo.png"]);
  });
});
