import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
  type CampaignBrief,
} from "@campaignfoundry/CampaignOrchestration";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { setCapabilities } from "../../../lib/capabilities.js";
import { inputKey, inputPrefix } from "../../../lib/object-store/object-keys.js";
import { resetObjectStoreClient, setObjectStoreClient } from "../../../lib/object-store/index.js";
import { getAssetStore, resetAssetStore } from "../../../lib/ports/index.js";
import { FsAssetStore } from "../../../lib/ports/fs-asset-store.js";
import { ObjectAssetStore } from "../../../lib/ports/object-asset-store.js";
import { PgBriefStore } from "../../../lib/ports/pg-brief-store.js";
import type { SqlClient } from "../../../lib/db/sql-client.js";
import type { TenantContext } from "../../../lib/tenant.js";
import {
  mountTenantRoute,
  setupPgHarness,
  type PgHarness,
} from "../../__tests__/tenant-harness.js";
import assetsPostHandler from "../assets.post.js";
import briefsPutHandler from "../briefs/[id].put.js";

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

const put = (tenant: TenantContext, id: string, body: unknown, query = "") =>
  mountTenantRoute(briefsPutHandler, { method: "PUT", path: "/campaigns/briefs/:id", tenant })(
    new Request(`http://x/campaigns/briefs/${id}${query}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

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

describe("put route compensation (s3 on pg)", () => {
  let harness: PgHarness;
  let objectStore: InMemoryObjectStore;
  let ownerStore: PgBriefStore;
  let seq = 0;
  const unique = (prefix: string): string => `${prefix}-${(seq += 1)}`;
  const SAVED_OBJECT_STORE = process.env.OBJECT_STORE;

  /** A campaign of its own, uploaded to, and versioned. */
  const freshTarget = async (versioned: boolean): Promise<{ slug: string; ownId: string }> => {
    const slug = unique("target");
    await ownerStore.createCampaign(slug, { teamId: "t1" });
    const ownId = await upload(OWNER, slug);
    if (versioned) await ownerStore.createBrief(baseBrief(slug, pathRef(slug)), { teamId: "t1" });
    return { slug, ownId };
  };

  /** A visible foreign campaign of its own, with three uploads: `logo.png` = PNG (the
   * same bytes the target's own logo holds, so `copyAssets` REUSES it), `alt.png` = PNG_ALT
   * and `bg.png` = PNG_ALT2. */
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

  const watch = () => {
    const seen = new Map<string, ReadonlySet<string>>();
    const real = ObjectAssetStore.prototype.copyAssets;
    const copy = vi
      .spyOn(ObjectAssetStore.prototype, "copyAssets")
      .mockImplementation(async function (this: ObjectAssetStore, from: string, to: string) {
        const result = await real.call(this, from, to);
        if (!seen.has(from)) seen.set(from, result.created);
        return result;
      });
    const free = vi.spyOn(ObjectAssetStore.prototype, "freeUnreferencedAssets");
    const del = vi.spyOn(ObjectAssetStore.prototype, "deleteAssets");
    return { copy, seen, free, del };
  };

  const uuidOf = async (slug: string): Promise<string> => {
    const { rows } = await harness.db.query<{ id: string }>(
      `select id from campaign where org_id = $1 and slug = $2`,
      ["local", slug],
    );
    return rows[0]!.id;
  };

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
    if (SAVED_OBJECT_STORE === undefined) delete process.env.OBJECT_STORE;
    else process.env.OBJECT_STORE = SAVED_OBJECT_STORE;
    await harness.cleanup();
  });

  test("put route frees exactly the ids it created when rewriteBrief fails after the copy under s3", async () => {
    const target = await freshTarget(true);
    const source = await seedSource();
    const targetUuid = await uuidOf(target.slug);
    const snapshot = await counts(harness.db);
    const { seen, free, del } = watch();
    vi.spyOn(PgBriefStore.prototype, "rewriteBrief").mockRejectedValueOnce(new Error("boom"));

    const res = await put(ONLY_T1, target.slug, allForeignId(target.slug, source.ids.alt));
    expect(res.status).toBe(500);

    expect(seen.get(source.slug)?.size).toBe(2);
    expect(free).toHaveBeenCalledTimes(1);
    expect(free.mock.calls[0][0]).toBe(target.slug);
    expect([...(free.mock.calls[0][1] as readonly string[])].sort()).toEqual(
      [...(seen.get(source.slug) ?? new Set<string>())].sort(),
    );
    expect(del).not.toHaveBeenCalled();
    expect(await rowsOf(target.slug)).toEqual([{ id: target.ownId, name: "logo.png" }]);
    expect(await keysOf(target.slug)).toEqual([inputKey("local", targetUuid, target.ownId)]);
    expect((await counts(harness.db)).versions).toBe(snapshot.versions);
  });

  test("put route with a forced 409 after the copy leaves no created row under s3", async () => {
    const target = await freshTarget(true);
    const source = await seedSource();
    const snapshot = await counts(harness.db);
    const { seen, free, del } = watch();
    const rev0 = await ownerStore.getRevision(target.slug);
    vi.spyOn(PgBriefStore.prototype, "rewriteBrief").mockRejectedValueOnce(
      Object.assign(new Error("Brief was modified by another user."), {
        code: "ECONFLICT",
        revision: "r-newer",
      }),
    );

    const res = await put(
      ONLY_T1,
      target.slug,
      allForeignId(target.slug, source.ids.alt),
      `?revision=${rev0}`,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Brief was modified by another user.",
      revision: "r-newer",
    });

    expect(seen.has(source.slug)).toBe(true);
    expect(free).toHaveBeenCalledTimes(1);
    expect(free.mock.calls[0][0]).toBe(target.slug);
    expect([...(free.mock.calls[0][1] as readonly string[])].sort()).toEqual(
      [...(seen.get(source.slug) ?? new Set<string>())].sort(),
    );
    expect(del).not.toHaveBeenCalled();
    expect(await rowsOf(target.slug)).toEqual([{ id: target.ownId, name: "logo.png" }]);
    expect((await keysOf(target.slug)).length).toBe(1);
    expect((await counts(harness.db)).versions).toBe(snapshot.versions);
  });

  test("put route keeps what a winning write reused and named when its own revision goes stale under s3", async () => {
    const target = await freshTarget(true);
    const source = await seedSource();
    const targetUuid = await uuidOf(target.slug);
    const snapshot = await counts(harness.db);
    const { seen, free } = watch();

    const realRewrite = PgBriefStore.prototype.rewriteBrief;
    let altTargetId!: string;
    let winnerRev!: string;
    const rev0 = await ownerStore.getRevision(target.slug);
    vi.spyOn(PgBriefStore.prototype, "rewriteBrief").mockImplementationOnce(async function (
      this: PgBriefStore,
      ...args: Parameters<PgBriefStore["rewriteBrief"]>
    ) {
      const [brief, options] = args;
      altTargetId = (
        await harness.db.query<{ id: string }>(
          `select id from asset where org_id = 'local' and campaign_id = $1 and name = $2`,
          [targetUuid, "alt.png"],
        )
      ).rows[0].id;
      // The other writer's own copy REUSES the request's rows by sha256.
      const reused = await new ObjectAssetStore(harness.db, objectStore, "local").copyAssets(
        source.slug,
        target.slug,
      );
      expect([...reused.created]).toEqual([]);
      const other = new PgBriefStore(harness.db, "local", "other-instance", ["owner"], [], true);
      const stored = await realRewrite.call(other, baseBrief(target.slug, altTargetId), {
        expectedRevision: rev0,
      });
      winnerRev = stored.revision;
      // Now THIS request's own write, with the now-stale rev0, throws ECONFLICT itself.
      return realRewrite.call(this, brief, options);
    });

    const res = await put(
      ONLY_T1,
      target.slug,
      allForeignId(target.slug, source.ids.alt),
      `?revision=${rev0}`,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Brief was modified by another user.",
      revision: winnerRev,
    });

    expect(await rowsOf(target.slug)).toEqual([
      { id: altTargetId, name: "alt.png" },
      { id: target.ownId, name: "logo.png" },
    ]);
    expect((await keysOf(target.slug)).length).toBe(2);
    expect((await counts(harness.db)).versions).toBe(snapshot.versions + 1);
    expect(free).toHaveBeenCalledTimes(1);
    expect([...(free.mock.calls[0][1] as readonly string[])].sort()).toEqual(
      [...(seen.get(source.slug) ?? new Set<string>())].sort(),
    );
  });

  test("put route frees every copy when the post-copy ref check refuses under s3", async () => {
    const target = await freshTarget(true);
    const source = await seedSource();
    const srcUuid = await uuidOf(source.slug);
    const snapshot = await counts(harness.db);
    const real = ObjectAssetStore.prototype.copyAssets;
    const { copy, seen, free, del } = watch();
    copy.mockImplementationOnce(async function (this: ObjectAssetStore, from: string, to: string) {
      await harness.db.query(
        `delete from asset where org_id = 'local' and campaign_id = $1 and name = $2`,
        [srcUuid, "alt.png"],
      );
      const r = await real.call(this, from, to);
      seen.set(from, r.created);
      return r;
    });

    const res = await put(ONLY_T1, target.slug, allForeignId(target.slug, source.ids.alt));
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toEqual({
      error: `Brief "${target.slug}" not found.`,
    });

    expect(free).toHaveBeenCalledTimes(1);
    expect([...(free.mock.calls[0][1] as readonly string[])].sort()).toEqual(
      [...(seen.get(source.slug) ?? new Set<string>())].sort(),
    );
    expect(del).not.toHaveBeenCalled();
    expect(await rowsOf(target.slug)).toEqual([{ id: target.ownId, name: "logo.png" }]);
    expect((await keysOf(target.slug)).length).toBe(1);
    expect((await counts(harness.db)).versions).toBe(snapshot.versions);
  });

  test("put route answers the original error and logs nothing when the free fails under s3", async () => {
    const target = await freshTarget(true);
    const source = await seedSource();
    const { free, del } = watch();
    free.mockRejectedValueOnce(new Error("free failed"));
    const rev0 = await ownerStore.getRevision(target.slug);
    vi.spyOn(PgBriefStore.prototype, "rewriteBrief").mockRejectedValueOnce(
      Object.assign(new Error("Brief was modified by another user."), {
        code: "ECONFLICT",
        revision: "r-newer",
      }),
    );
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errored = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await put(
      ONLY_T1,
      target.slug,
      allForeignId(target.slug, source.ids.alt),
      `?revision=${rev0}`,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Brief was modified by another user.",
      revision: "r-newer",
    });

    expect(free).toHaveBeenCalledTimes(1);
    expect(del).not.toHaveBeenCalled();
    expect((await rowsOf(target.slug)).map((r) => r.name).sort()).toEqual([
      "alt.png",
      "bg.png",
      "logo.png",
    ]);
    expect(warned).not.toHaveBeenCalled();
    expect(errored).not.toHaveBeenCalled();
  });

  test("put route resolves a uuid id to the slug and keeps its copies on success under s3", async () => {
    // The D178/D179 path: the router id is a campaign uuid, not its slug, so
    // `briefToSave` is remapped to the slug (the `brief.id === slug` false arm).
    const target = await freshTarget(true);
    const source = await seedSource();
    const targetUuid = await uuidOf(target.slug);
    const snapshot = await counts(harness.db);
    const { seen, free, del } = watch();

    const res = await put(ONLY_T1, targetUuid, allForeignId(targetUuid, source.ids.alt));
    expect(res.status).toBe(200);
    expect(free).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(seen.has(source.slug)).toBe(true);
    expect((await rowsOf(target.slug)).length).toBe(3);
    expect((await counts(harness.db)).versions).toBe(snapshot.versions + 1);
  });

  test("put route surfaces a non-CampaignNotFoundError from resolveCampaignRef as 500", async () => {
    const target = await freshTarget(true);
    vi.spyOn(PgBriefStore.prototype, "resolveCampaign").mockRejectedValueOnce(new Error("boom"));
    const res = await put(ONLY_T1, target.slug, baseBrief(target.slug, pathRef(target.slug)));
    expect(res.status).toBe(500);
  });
});

describe("put route compensation on pg plus fs", () => {
  const SAVED_OBJECT_STORE = process.env.OBJECT_STORE;
  const SAVED_BACKEND = process.env.STORE_BACKEND;
  const SAVED_ROOT = process.env.PROJECT_ROOT;
  let harness: PgHarness;
  let ownerStore: PgBriefStore;
  let seq = 0;
  const unique = (prefix: string): string => `${prefix}-${(seq += 1)}`;
  const store = () => getAssetStore(ONLY_T1);

  const namesOf = async (briefId: string): Promise<string[]> =>
    (await store().listAssets(briefId)).map((a) => a.name);

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
    if (SAVED_ROOT === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = SAVED_ROOT;
    await harness.cleanup();
  });

  test("put route off s3 never copies and never calls the free when the write fails", async () => {
    const sourceSlug = unique("source-put-pgfs");
    const targetSlug = unique("target-put-pgfs");
    await ownerStore.createCampaign(sourceSlug, { teamId: "t1" });
    await store().writeAsset(sourceSlug, "alt.png", PNG_ALT);
    await ownerStore.createCampaign(targetSlug, { teamId: "t1" });
    await ownerStore.createBrief(baseBrief(targetSlug, pathRef(targetSlug)), { teamId: "t1" });
    const beforeFiles = await namesOf(targetSlug);

    const copy = vi.spyOn(FsAssetStore.prototype, "copyAssets");
    const free = vi.spyOn(FsAssetStore.prototype, "freeUnreferencedAssets");
    const visibility = vi.spyOn(PgBriefStore.prototype, "campaignVisibility");
    vi.spyOn(PgBriefStore.prototype, "rewriteBrief").mockRejectedValueOnce(new Error("boom"));

    const res = await put(
      ONLY_T1,
      targetSlug,
      baseBrief(targetSlug, `assets/inputs/${sourceSlug}/alt.png`),
    );
    expect(res.status).toBe(500);

    // PUT off s3 neither copies nor re-checks nor frees (decisions 8 & 15).
    expect(copy).not.toHaveBeenCalled();
    expect(free).not.toHaveBeenCalled();
    expect(visibility).not.toHaveBeenCalled();
    expect(await namesOf(targetSlug)).toEqual(beforeFiles);
  });
});
