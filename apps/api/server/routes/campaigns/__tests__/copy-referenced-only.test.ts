import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { setCapabilities } from "../../../lib/capabilities.js";
import { inputKey, inputPrefix } from "../../../lib/object-store/object-keys.js";
import { resetObjectStoreClient, setObjectStoreClient } from "../../../lib/object-store/index.js";
import { getAssetStore, resetAssetStore } from "../../../lib/ports/index.js";
import { ObjectAssetStore } from "../../../lib/ports/object-asset-store.js";
import { FsAssetStore } from "../../../lib/ports/fs-asset-store.js";
import { PgBriefStore } from "../../../lib/ports/pg-brief-store.js";
import type { CopyAssetsOptions } from "../../../lib/ports/asset-store.port.js";
import type { SqlClient } from "../../../lib/db/sql-client.js";
import type { TenantContext } from "../../../lib/tenant.js";
import {
  mountTenantRoute,
  setupPgHarness,
  type PgHarness,
} from "../../__tests__/tenant-harness.js";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
} from "@campaignfoundry/CampaignOrchestration";
import assetsPostHandler from "../assets.post.js";
import briefsPostHandler from "../briefs.post.js";
import briefsPutHandler from "../briefs/[id].put.js";
import duplicatePostHandler from "../briefs/[id]/duplicate.post.js";

/**
 * The route-level contract of PT-9k (D238): a Save-as and a PUT hand `only` to the
 * copy, a duplicate does not, and a failure frees exactly the ids the narrowed copy
 * minted. Offline: `setupPgHarness` (PGlite) and an `InMemoryObjectStore`, no `S3_*`.
 */

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_ALT = Buffer.concat([PNG, Buffer.from([0x00])]);
const PNG_ALT2 = Buffer.concat([PNG, Buffer.from([0x00, 0x00])]);

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

/** Every ref of an `s3` brief is the foreign `ref` — the carry-item shape. */
const allForeignId = (id: string, ref: string): CampaignBrief => ({
  ...baseBrief(id, ref),
  mode: "variation",
  output: { formats: ["motion"] },
  variation: { count: 1 },
  products: [{ id: "p1", name: "P1", primaryColor: "#1473E3", logoPath: ref, inputAsset: ref }],
  audio: { path: ref, rights: { licenceId: "lic-1", source: "library" } },
  copy: {
    timeline: {
      beats: [{ text: "Go", weight: 2, background: ref }],
      transition: "cut",
      keyBeat: 1,
    },
  },
});

/** Every ref of a stored brief, in `collectRefs` order, de-duplicated. */
const storedRefs = (brief: CampaignBrief): string[] => {
  const refs: string[] = [];
  for (const product of brief.products) {
    refs.push(product.logoPath);
    if (product.inputAsset !== undefined) refs.push(product.inputAsset);
  }
  if (brief.audio !== undefined) refs.push(brief.audio.path);
  for (const beat of brief.copy?.timeline?.beats ?? []) {
    if (beat.background !== undefined) refs.push(beat.background);
  }
  return [...new Set(refs)];
};

const post = (tenant: TenantContext, body: unknown, query = "") =>
  mountTenantRoute(briefsPostHandler, { method: "POST", path: "/campaigns/briefs", tenant })(
    new Request(`http://x/campaigns/briefs${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const put = (tenant: TenantContext, id: string, body: unknown, query = "") =>
  mountTenantRoute(briefsPutHandler, { method: "PUT", path: "/campaigns/briefs/:id", tenant })(
    new Request(`http://x/campaigns/briefs/${id}${query}`, {
      method: "PUT",
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

/** Upload through the real route, so every id under test is one `writeAsset` minted. */
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

describe("copy-referenced-only under s3 (PT-9k, D238)", () => {
  let harness: PgHarness;
  let objectStore: InMemoryObjectStore;
  let ownerStore: PgBriefStore;
  let seq = 0;
  const unique = (prefix: string): string => `${prefix}-${(seq += 1)}`;
  const SAVED_BACKEND = process.env.STORE_BACKEND;
  const SAVED_OBJECT_STORE = process.env.OBJECT_STORE;

  const store = () => getAssetStore(ONLY_T1);

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

  const rowsOf = async (slug: string): Promise<{ id: string; name: string }[]> => {
    const uuid = await uuidOf(slug);
    return (
      await harness.db.query<{ id: string; name: string }>(
        `select id, name from asset where org_id = 'local' and campaign_id = $1 order by name`,
        [uuid],
      )
    ).rows;
  };

  const keysOf = async (slug: string): Promise<string[]> => {
    const uuid = await uuidOf(slug);
    return (await objectStore.list(inputPrefix("local", uuid))).map((o) => o.key).sort();
  };

  /** A campaign of its own, uploaded to, and — for PUT — versioned. */
  const freshTarget = async (versioned: boolean): Promise<{ slug: string; ownId: string }> => {
    const slug = unique("target");
    await ownerStore.createCampaign(slug, { teamId: "t1" });
    const ownId = await upload(OWNER, slug);
    if (versioned) await ownerStore.createBrief(baseBrief(slug, pathRef(slug)), { teamId: "t1" });
    return { slug, ownId };
  };

  /** A visible foreign campaign of its own, with three uploads: `logo.png` = PNG (the
   * same bytes the target's own logo holds, so `copyAssets` REUSES it), `alt.png` =
   * PNG_ALT and `bg.png` = PNG_ALT2. */
  const seedSource = async (): Promise<{
    slug: string;
    ids: { logo: string; alt: string; bg: string };
  }> => {
    const slug = unique("source");
    await ownerStore.createCampaign(slug, { teamId: "t1" });
    const logo = await upload(OWNER, slug, "logo.png", PNG);
    const alt = await upload(OWNER, slug, "alt.png", PNG_ALT);
    const bg = await upload(OWNER, slug, "bg.png", PNG_ALT2);
    return { slug, ids: { logo, alt, bg } };
  };

  /** Installs spies that record the first write of each source's `created` set. The
   * s3 wrapper forwards `options` so the real adapter narrows the copy. */
  const watch = () => {
    const seen = new Map<string, ReadonlySet<string>>();
    const real = ObjectAssetStore.prototype.copyAssets;
    const copy = vi
      .spyOn(ObjectAssetStore.prototype, "copyAssets")
      .mockImplementation(async function (
        this: ObjectAssetStore,
        from: string,
        to: string,
        options?: CopyAssetsOptions,
      ) {
        const result = await real.call(this, from, to, options);
        if (!seen.has(from)) seen.set(from, result.created);
        return result;
      });
    const free = vi.spyOn(ObjectAssetStore.prototype, "freeUnreferencedAssets");
    const del = vi.spyOn(ObjectAssetStore.prototype, "deleteAssets");
    return { copy, seen, free, del };
  };

  beforeAll(async () => {
    setCapabilities({ motion: true });
    process.env.STORE_BACKEND = "postgres";
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

  test("save route copies only the referenced asset of a three-row source under s3 (M9)", async () => {
    const { slug } = await freshTarget(false);
    const source = await seedSource();
    const targetUuid = await uuidOf(slug);
    const snapshot = await counts(harness.db);
    const { seen, copy, free, del } = watch();

    const res = await post(ONLY_T1, allForeignId(slug, source.ids.alt));
    expect(res.status).toBe(201);

    // The target holds the target's own logo plus the one asset the brief named; bg is
    // narrowed out of the copy.
    expect((await assetRows(targetUuid)).sort()).toEqual(["alt.png", "logo.png"]);
    expect((await keysOf(slug)).length).toBe(2);
    // The copy was asked for ONLY the named asset.
    expect(copy).toHaveBeenCalledWith(source.slug, slug, { only: ["alt.png"] });
    expect(seen.get(source.slug)?.size).toBe(1);
    // The stored ref is remapped onto the TARGET's own id.
    const stored = ((await res.json()) as { brief: CampaignBrief }).brief;
    const refs = storedRefs(stored);
    expect(refs).toHaveLength(1);
    for (const ref of refs) {
      const owner = await store().assetOwner(ref);
      expect(owner?.slug).toBe(slug);
    }
    expect(free).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    // The source still holds its three rows and three objects.
    const srcUuid = await uuidOf(source.slug);
    expect((await assetRows(srcUuid)).sort()).toEqual(["alt.png", "bg.png", "logo.png"]);
    expect((await keysOf(source.slug)).length).toBe(3);
    expect((await counts(harness.db)).versions).toBe(snapshot.versions + 1);
  });

  test("put route copies only the referenced asset of a three-row source under s3 (M10)", async () => {
    const { slug } = await freshTarget(true);
    const source = await seedSource();
    const targetUuid = await uuidOf(slug);
    const rev0 = await ownerStore.getRevision(slug);
    const { copy, free, del } = watch();

    const res = await put(ONLY_T1, slug, allForeignId(slug, source.ids.alt), `?revision=${rev0}`);
    expect(res.status).toBe(200);

    expect((await assetRows(targetUuid)).sort()).toEqual(["alt.png", "logo.png"]);
    expect((await keysOf(slug)).length).toBe(2);
    expect(copy).toHaveBeenCalledWith(source.slug, slug, { only: ["alt.png"] });
    expect(free).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    const srcUuid = await uuidOf(source.slug);
    expect((await assetRows(srcUuid)).sort()).toEqual(["alt.png", "bg.png", "logo.png"]);
    expect((await keysOf(source.slug)).length).toBe(3);
  });

  test("duplicate route still copies the whole library of its source under s3 (control; no mutation)", async () => {
    const sourceSlug = unique("source");
    await ownerStore.createCampaign(sourceSlug, { teamId: "t1" });
    const logoId = await upload(OWNER, sourceSlug, "logo.png", PNG);
    await upload(OWNER, sourceSlug, "extra.png", PNG_ALT);
    await ownerStore.createBrief(baseBrief(sourceSlug, logoId), { teamId: "t1" });
    const { copy } = watch();

    const res = await duplicate(ONLY_T1, sourceSlug, unique("copy"));
    expect(res.status).toBe(201);
    const newSlug = ((await res.json()) as { brief: CampaignBrief }).brief.id;

    // The whole library is copied: both the source's own logo and extra.png.
    expect((await assetRows(await uuidOf(newSlug))).sort()).toEqual(["extra.png", "logo.png"]);
    expect((await keysOf(newSlug)).length).toBe(2);
    // Duplicate keeps the two-argument call (no `only`).
    expect(copy).toHaveBeenCalledWith(sourceSlug, newSlug);
  });

  test("save route frees the narrowed copy when the write fails under s3 (control; no mutation)", async () => {
    const { slug, ownId } = await freshTarget(false);
    const source = await seedSource();
    const targetUuid = await uuidOf(slug);
    const snapshot = await counts(harness.db);
    const { seen, free, del } = watch();
    vi.spyOn(PgBriefStore.prototype, "createBrief").mockRejectedValueOnce(new Error("boom"));

    const res = await post(ONLY_T1, allForeignId(slug, source.ids.alt));
    expect(res.status).toBe(500);

    // The copy named only alt.png, so exactly one id was created — and freed.
    expect(seen.get(source.slug)?.size).toBe(1);
    expect(free).toHaveBeenCalledTimes(1);
    expect(free.mock.calls[0][0]).toBe(slug);
    expect([...(free.mock.calls[0][1] as readonly string[])].sort()).toEqual(
      [...(seen.get(source.slug) ?? new Set<string>())].sort(),
    );
    expect(del).not.toHaveBeenCalled();
    expect(await rowsOf(slug)).toEqual([{ id: ownId, name: "logo.png" }]);
    expect(await keysOf(slug)).toEqual([inputKey("local", targetUuid, ownId)]);
    expect((await counts(harness.db)).versions).toBe(snapshot.versions);
  });
});

describe("copy-referenced-only on pg plus fs (PT-9k, D238)", () => {
  let harness: PgHarness;
  let ownerStore: PgBriefStore;
  let seq = 0;
  const unique = (prefix: string): string => `${prefix}-${(seq += 1)}`;
  const SAVED_BACKEND = process.env.STORE_BACKEND;
  const SAVED_OBJECT_STORE = process.env.OBJECT_STORE;
  const SAVED_ROOT = process.env.PROJECT_ROOT;

  const store = () => getAssetStore(ONLY_T1);
  const namesOf = async (slug: string): Promise<string[]> =>
    (await store().listAssets(slug)).map((a) => a.name);

  beforeAll(async () => {
    setCapabilities({ motion: true });
    process.env.STORE_BACKEND = "postgres";
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
    resetObjectStoreClient();
    resetAssetStore();
    if (SAVED_BACKEND === undefined) delete process.env.STORE_BACKEND;
    else process.env.STORE_BACKEND = SAVED_BACKEND;
    if (SAVED_OBJECT_STORE === undefined) delete process.env.OBJECT_STORE;
    else process.env.OBJECT_STORE = SAVED_OBJECT_STORE;
    if (SAVED_ROOT === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = SAVED_ROOT;
    await harness.cleanup();
  });

  test("save route on pg plus fs copies only the referenced file (M9 on fs)", async () => {
    const sourceSlug = unique("source-pgfs");
    const targetSlug = unique("target-pgfs");
    await ownerStore.createCampaign(sourceSlug, { teamId: "t1" });
    await store().writeAsset(sourceSlug, "logo.png", PNG);
    await store().writeAsset(sourceSlug, "alt.png", PNG_ALT);
    await store().writeAsset(sourceSlug, "bg.png", PNG_ALT2);
    await ownerStore.createCampaign(targetSlug, { teamId: "t1" });
    await store().writeAsset(targetSlug, "logo.png", PNG);
    const copy = vi.spyOn(FsAssetStore.prototype, "copyAssets");

    const res = await post(ONLY_T1, baseBrief(targetSlug, `assets/inputs/${sourceSlug}/alt.png`));
    expect(res.status).toBe(201);

    // alt.png reached the target (plus its own logo); bg.png did not.
    expect((await namesOf(targetSlug)).sort()).toEqual(["alt.png", "logo.png"]);
    expect(await store().readAsset(targetSlug, "bg.png")).toBeUndefined();
    expect(copy).toHaveBeenCalledWith(sourceSlug, targetSlug, { only: ["alt.png"] });
  });

  test("save route on pg plus fs copies the file a doubled-slash path ref names", async () => {
    const sourceSlug = unique("source-slash");
    const targetSlug = unique("target-slash");
    await ownerStore.createCampaign(sourceSlug, { teamId: "t1" });
    await store().writeAsset(sourceSlug, "logo.png", PNG);
    await ownerStore.createCampaign(targetSlug, { teamId: "t1" });
    // `assets/inputs/<source>//logo.png` — `posix.normalize` leaves `/logo.png`, so only
    // the slash-strip keeps "logo.png" as the name the copy is narrowed to.
    const res = await post(ONLY_T1, baseBrief(targetSlug, `assets/inputs/${sourceSlug}//logo.png`));
    expect(res.status).toBe(201);
    expect((await namesOf(targetSlug)).sort()).toEqual(["logo.png"]);
  });

  test("save route on pg plus fs copies nothing from a campaign named only by a bare-slash ref", async () => {
    const sourceSlug = unique("source-bare");
    const targetSlug = unique("target-bare");
    await ownerStore.createCampaign(sourceSlug, { teamId: "t1" });
    await store().writeAsset(sourceSlug, "logo.png", PNG);
    await store().writeAsset(sourceSlug, "alt.png", PNG_ALT);
    await store().writeAsset(sourceSlug, "bg.png", PNG_ALT2);
    await ownerStore.createCampaign(targetSlug, { teamId: "t1" });
    const baseline = (await namesOf(sourceSlug)).sort();
    const copy = vi.spyOn(FsAssetStore.prototype, "copyAssets");

    const res = await post(ONLY_T1, baseBrief(targetSlug, `assets/inputs/${sourceSlug}//`));
    expect(res.status).toBe(201);

    expect(await namesOf(targetSlug)).toEqual([]);
    expect(copy).toHaveBeenCalledWith(sourceSlug, targetSlug, { only: [] });
    expect((await namesOf(sourceSlug)).sort()).toEqual(baseline);
  });
});
