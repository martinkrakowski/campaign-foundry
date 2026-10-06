import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
import {
  getAssetStore,
  getBriefStore,
  getPoolStore,
  resetAssetStore,
} from "../../../lib/ports/index.js";
import { FsAssetStore } from "../../../lib/ports/fs-asset-store.js";
import { ObjectAssetStore } from "../../../lib/ports/object-asset-store.js";
import { PgBriefStore } from "../../../lib/ports/pg-brief-store.js";
import { FsBriefStore } from "../../../lib/ports/fs-brief-store.js";
import type { SqlClient } from "../../../lib/db/sql-client.js";
import type { TenantContext } from "../../../lib/tenant.js";
import * as pools from "../../../lib/pools.js";
import {
  LOCAL_TENANT,
  mountTenantRoute,
  setupFsHarness,
  setupPgHarness,
  type FsHarness,
  type PgHarness,
} from "../../__tests__/tenant-harness.js";
import assetsPostHandler from "../assets.post.js";
import indexPostHandler from "../index.post.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_ALT = Buffer.concat([PNG, Buffer.from([0x00])]);
const PNG_ALT2 = Buffer.concat([PNG, Buffer.from([0x00, 0x00])]);
const PNG_THIRD = Buffer.concat([PNG, Buffer.from([0x00, 0x00, 0x00])]);

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

const createFrom = (tenant: TenantContext, body: unknown) =>
  mountTenantRoute(indexPostHandler, { method: "POST", path: "/campaigns", tenant })(
    new Request("http://x/campaigns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
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

const unionSorted = (a: ReadonlySet<string>, b: ReadonlySet<string>): string[] =>
  [...new Set([...a, ...b])].sort();

/**
 * The create compensation under s3 on pg (PT-9j1, D237): the index.post rollback frees
 * exactly the ids this request minted, re-checks the source after copying, and never frees a
 * winning Save's version-named assets.
 */
describe("create compensation under s3 on pg", () => {
  let harness: PgHarness;
  let objectStore: InMemoryObjectStore;
  let ownerStore: PgBriefStore;
  const SAVED_OBJECT_STORE = process.env.OBJECT_STORE;

  let seq = 0;
  const unique = (prefix: string): string => `${prefix}-${(seq += 1)}`;

  // The four spies/state the route's rollback touches; installed per test by `watch`.
  let mint: ReturnType<typeof vi.spyOn>;
  let seen: Map<string, ReadonlySet<string>>;
  let free: ReturnType<typeof vi.spyOn>;
  let copy: ReturnType<typeof vi.spyOn>;

  const minted = async () =>
    (await mint.mock.results[0]!.value) as { campaignId: string; slug: string };

  const watch = (interleave?: { hidden: string }) => {
    seen = new Map();
    mint = vi.spyOn(PgBriefStore.prototype, "createCampaign");
    const realCopy = ObjectAssetStore.prototype.copyAssets;
    copy = vi.spyOn(ObjectAssetStore.prototype, "copyAssets").mockImplementation(async function (
      this: ObjectAssetStore,
      from: string,
      to: string,
    ) {
      const result = await realCopy.call(this, from, to);
      // FIRST write wins: a competing writer copies through the same prototype spy and must
      // never overwrite the request's own record (test 2 reuses by sha256).
      if (!seen.has(from)) seen.set(from, result.created);
      if (interleave && from === interleave.hidden) {
        await harness.db.query(
          `update campaign set team_id = 't2' where org_id = 'local' and slug = $1`,
          [from],
        );
      }
      return result;
    });
    free = vi.spyOn(ObjectAssetStore.prototype, "freeUnreferencedAssets");
    return { mint, seen, free, copy };
  };

  /** Pre-hide a source (reassign before the request) to capture the resolve-time-hidden 404 for byte-for-byte comparison. */
  const preHide = async (slug: string): Promise<void> => {
    await harness.db.query(
      `update campaign set team_id = 't2' where org_id = 'local' and slug = $1`,
      [slug],
    );
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

  const targetKeys = async (campaignId: string): Promise<string[]> =>
    (await objectStore.list(inputPrefix("local", campaignId))).map((o) => o.key).sort();

  const expectSourcesUntouched = async (
    ...who: { slug: string; rows: readonly string[]; objects: number }[]
  ): Promise<void> => {
    for (const w of who) {
      const uuid = await uuidOf(w.slug);
      expect(await assetRows(uuid)).toEqual([...w.rows]);
      expect((await targetKeys(uuid)).length).toBe(w.objects);
    }
  };

  /** Campaign `slug` in team t1, uploads logo.png (PNG_ALT) and extra.png (PNG_ALT2), then a brief that names logo.png only — so extra.png is copied but unreferenced. */
  const seedSource = async (prefix: string): Promise<{ slug: string; campaignId: string }> => {
    const slug = unique(prefix);
    const { campaignId } = await ownerStore.createCampaign(slug, { teamId: "t1" });
    await upload(OWNER, slug, "logo.png", PNG_ALT);
    await upload(OWNER, slug, "extra.png", PNG_ALT2);
    await ownerStore.createBrief(baseBrief(slug, pathRef(slug)), { teamId: "t1" });
    return { slug, campaignId };
  };

  /** As `seedSource`, but the source brief names the THIRD campaign's logo id, so the copy carries it over. */
  const seedSourceWithThird = async (
    prefix: string,
  ): Promise<{ slug: string; campaignId: string; third: { slug: string; id: string } }> => {
    const thirdSlug = unique("third");
    await ownerStore.createCampaign(thirdSlug, { teamId: "t1" });
    const thirdId = await upload(OWNER, thirdSlug, "logo.png", PNG_THIRD);
    const slug = unique(prefix);
    const { campaignId } = await ownerStore.createCampaign(slug, { teamId: "t1" });
    await upload(OWNER, slug, "logo.png", PNG_ALT);
    await upload(OWNER, slug, "extra.png", PNG_ALT2);
    await ownerStore.createBrief(
      {
        ...baseBrief(slug, pathRef(slug)),
        products: [{ id: "p1", name: "P1", primaryColor: "#1473E3", logoPath: thirdId }],
      },
      { teamId: "t1" },
    );
    return { slug, campaignId, third: { slug: thirdSlug, id: thirdId } };
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

  // --- Batch 1 ---

  test("create route frees exactly the ids it created when the write fails after the copy under s3", async () => {
    const src = await seedSourceWithThird(unique("src"));
    const source = { slug: src.slug, campaignId: src.campaignId };
    const third = src.third;
    const snapshot = await counts(harness.db);

    watch();
    vi.spyOn(PgBriefStore.prototype, "createBrief").mockRejectedValueOnce(new Error("boom"));
    const deleteAssets = vi.spyOn(ObjectAssetStore.prototype, "deleteAssets");

    const res = await createFrom(ONLY_T1, { name: unique("copy"), source: source.campaignId });
    expect(res.status).toBe(500);

    const m = await minted();
    expect(free).toHaveBeenCalledTimes(1);
    expect(free.mock.calls[0]![0]).toBe(m.slug);
    const freeIds = free.mock.calls[0]![1] as string[];
    expect([...freeIds].sort()).toEqual(unionSorted(seen.get(source.slug)!, seen.get(third.slug)!));
    expect(deleteAssets).not.toHaveBeenCalled();
    expect(await objectStore.list(inputPrefix("local", m.campaignId))).toEqual([]);
    expect(await counts(harness.db)).toEqual(snapshot);
    await expectSourcesUntouched(
      { slug: source.slug, rows: ["extra.png", "logo.png"], objects: 2 },
      { slug: third.slug, rows: ["logo.png"], objects: 1 },
    );
  });

  test("create route keeps what a winning Save reused and named and frees the rest when it loses the slug under s3", async () => {
    const source = await seedSource(unique("src"));
    const snapshot = await counts(harness.db);
    let logoId!: string;

    watch();
    const deleteAssets = vi.spyOn(ObjectAssetStore.prototype, "deleteAssets");
    const real = PgBriefStore.prototype.createBrief;
    vi.spyOn(PgBriefStore.prototype, "createBrief").mockImplementationOnce(
      async (body, options) => {
        const { rows } = await harness.db.query<{ id: string }>(
          `select id from asset where org_id = 'local' and campaign_id = (select id from campaign where org_id = 'local' and slug = $1) and name = 'logo.png'`,
          [body.id],
        );
        logoId = rows[0]!.id;
        // The winning Save's own copy REUSES this request's rows by sha256 (created empty); it rides
        // the same copyAssets spy, which is why seen stays first-write-wins.
        const b = await new ObjectAssetStore(harness.db, objectStore, "local").copyAssets(
          source.slug,
          body.id,
        );
        expect([...b.created]).toEqual([]);
        await real.call(
          new PgBriefStore(harness.db, "local", "other-instance", ["owner"], [], true),
          baseBrief(body.id, logoId),
          options,
        );
        throw Object.assign(new Error(`Brief "${body.id}" already exists.`), { code: "EEXIST" });
      },
    );

    const res = await createFrom(ONLY_T1, { name: unique("copy"), source: source.campaignId });
    expect(res.status).toBe(409);
    const m = await minted();
    expect(await res.json()).toEqual({ error: `Brief "${m.slug}" already exists.` });

    expect(await assetRows(m.campaignId)).toEqual(["logo.png"]);
    expect(await targetKeys(m.campaignId)).toEqual([inputKey("local", m.campaignId, logoId)]);
    const { rows: versions } = await harness.db.query<{ n: number }>(
      `select count(*)::int as n from brief_version where campaign_id = $1`,
      [m.campaignId],
    );
    expect(versions[0]!.n).toBe(1);
    expect(free).toHaveBeenCalledTimes(1);
    expect([...(free.mock.calls[0]![1] as string[])].sort()).toEqual(
      [...seen.get(source.slug)!].sort(),
    );
    expect(deleteAssets).not.toHaveBeenCalled();
    await expectSourcesUntouched({
      slug: source.slug,
      rows: ["extra.png", "logo.png"],
      objects: 2,
    });
    void snapshot;
  });

  test("create route does not call the free when the copy created nothing under s3", async () => {
    const source = await seedSource(unique("src"));
    const snapshot = await counts(harness.db);

    watch();
    // A once-value wins over the wrapper for the one source copy; the source names no third
    // campaign, so there is no second call. The source's own brief id (resolved from the path)
    // survives the empty map, so assertRefsCopied refuses at the post-copy check.
    copy.mockResolvedValueOnce({ paths: {}, created: new Set() });

    const res = await createFrom(ONLY_T1, { name: unique("copy"), source: source.campaignId });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: `Brief "${source.campaignId}" not found.` });

    expect(free).not.toHaveBeenCalled();
    expect(await counts(harness.db)).toEqual(snapshot);
    const m = await minted();
    expect(await objectStore.list(inputPrefix("local", m.campaignId))).toEqual([]);
    expect(seen.get(source.slug)).toBeUndefined();
  });

  // --- Batch 2 (residual E, residual (ii), the third-campaign path) ---

  test("create route refuses and frees the source copy when the source is reassigned after its copy under s3", async () => {
    const source = await seedSource(unique("src"));
    const snapshot = await counts(harness.db);

    watch({ hidden: source.slug });

    const res = await createFrom(ONLY_T1, { name: unique("copy"), source: source.campaignId });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body).toEqual({ error: `Brief "${source.campaignId}" not found.` });

    // The SAME route with the source ALREADY reassigned answers the SAME s3 404 body — D210(c):
    // the resolve-time refusal is the same bytes, and neither body contains the source slug.
    await preHide(source.slug);
    const res2 = await createFrom(ONLY_T1, { name: unique("again"), source: source.campaignId });
    expect(res2.status).toBe(404);
    expect(await res2.json()).toEqual(body);
    expect(body.error).not.toContain(source.slug);

    const m = await minted();
    expect(seen.get(source.slug)).toBeDefined();
    expect(free).toHaveBeenCalledTimes(1);
    expect([...(free.mock.calls[0]![1] as string[])].sort()).toEqual(
      [...seen.get(source.slug)!].sort(),
    );
    expect(await objectStore.list(inputPrefix("local", m.campaignId))).toEqual([]);
    expect(await counts(harness.db)).toEqual(snapshot);
    await expectSourcesUntouched({
      slug: source.slug,
      rows: ["extra.png", "logo.png"],
      objects: 2,
    });
  });

  test("create route frees the source copy and the third campaign copy when the third is reassigned mid-request under s3", async () => {
    const src = await seedSourceWithThird(unique("src"));
    const source = { slug: src.slug, campaignId: src.campaignId };
    const third = src.third;
    const snapshot = await counts(harness.db);

    watch({ hidden: third.slug });

    const res = await createFrom(ONLY_T1, { name: unique("copy"), source: source.campaignId });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body).toEqual({ error: `Brief "${source.campaignId}" not found.` });

    await preHide(third.slug);
    const res2 = await createFrom(ONLY_T1, { name: unique("again"), source: source.campaignId });
    expect(res2.status).toBe(404);
    expect(await res2.json()).toEqual(body);
    expect(body.error).not.toContain(third.slug);

    const m = await minted();
    expect(free).toHaveBeenCalledTimes(2);
    // First copyBriefRefs frees the third's ids, then the route frees the source copy's.
    expect([...(free.mock.calls[0]![1] as string[])].sort()).toEqual(
      [...seen.get(third.slug)!].sort(),
    );
    expect([...(free.mock.calls[1]![1] as string[])].sort()).toEqual(
      [...seen.get(source.slug)!].sort(),
    );
    expect(await objectStore.list(inputPrefix("local", m.campaignId))).toEqual([]);
    expect(await counts(harness.db)).toEqual(snapshot);
    await expectSourcesUntouched(
      { slug: source.slug, rows: ["extra.png", "logo.png"], objects: 2 },
      { slug: third.slug, rows: ["logo.png"], objects: 1 },
    );
  });

  test("create route frees every copy when the post-copy ref check refuses under s3", async () => {
    const source = await seedSource(unique("src"));
    const snapshot = await counts(harness.db);
    const realCopy = ObjectAssetStore.prototype.copyAssets;

    watch();
    // The source copy deletes its own logo.png row before running the real copy, so only
    // extra.png is copied; the source's own id (resolved from path) survives the empty map
    // and assertRefsCopied refuses it.
    copy.mockImplementationOnce(async function (this: ObjectAssetStore, from: string, to: string) {
      await harness.db.query(
        `delete from asset where org_id = 'local' and campaign_id = (select id from campaign where org_id = 'local' and slug = $1) and name = 'logo.png'`,
        [from],
      );
      const r = await realCopy.call(this, from, to);
      seen.set(from, r.created);
      return r;
    });

    const res = await createFrom(ONLY_T1, { name: unique("copy"), source: source.campaignId });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: `Brief "${source.campaignId}" not found.` });

    const m = await minted();
    expect(free).toHaveBeenCalledTimes(1);
    expect([...(free.mock.calls[0]![1] as string[])].sort()).toEqual(
      [...seen.get(source.slug)!].sort(),
    );
    expect(await objectStore.list(inputPrefix("local", m.campaignId))).toEqual([]);
    expect((await counts(harness.db)).campaigns).toEqual(snapshot.campaigns);
  });

  // --- Batch 3 (the other failure points and the control) ---

  test("create route frees every copy when the pool copy fails under s3", async () => {
    const source = await seedSource(unique("src"));
    await getPoolStore(ONLY_T1).writePool({
      briefId: source.slug,
      generatedAt: new Date().toISOString(),
      model: "test-model",
      entries: [{ id: "e1", text: "Hi", status: "approved" }],
    });
    const snapshot = await counts(harness.db);
    watch();
    vi.spyOn(pools, "copyPool").mockRejectedValueOnce(new Error("pool boom"));

    const res = await createFrom(ONLY_T1, { name: unique("copy"), source: source.campaignId });
    expect(res.status).toBe(500);

    const m = await minted();
    expect(free).toHaveBeenCalledTimes(1);
    expect([...(free.mock.calls[0]![1] as string[])].sort()).toEqual(
      [...seen.get(source.slug)!].sort(),
    );
    expect(await objectStore.list(inputPrefix("local", m.campaignId))).toEqual([]);
    expect(await counts(harness.db)).toEqual(snapshot);
  });

  test("create route makes no free call of its own and leaves no object when the source copy itself throws part-way under s3", async () => {
    // Failure point 1: the SOURCE copy throws on its second asset, after the first asset's
    // object and row exist. `copyAssets` frees what it created itself (PT-9j0) and hands
    // nothing back from a throw, so the route's own `createdIds` is empty on this path and
    // the route must add no free of its own: the one call seen is the asset store's.
    const source = await seedSource(unique("src"));
    const snapshot = await counts(harness.db);
    watch();
    const realObjectCopy = objectStore.copy.bind(objectStore);
    vi.spyOn(objectStore, "copy")
      .mockImplementationOnce(async (...args) => realObjectCopy(...args))
      .mockRejectedValueOnce(new Error("s3 dropped"));

    const res = await createFrom(ONLY_T1, { name: unique("copy"), source: source.campaignId });
    expect(res.status).toBe(500);

    const m = await minted();
    expect(seen.has(source.slug)).toBe(false);
    expect(free).toHaveBeenCalledTimes(1);
    expect(free.mock.calls[0]![0]).toBe(m.slug);
    // That one call carries BOTH ids the copy minted: the store records an id before it copies
    // the object, so the failed asset is in the list too and matches no row. What matters here
    // is the count of calls: a second one would be the route freeing on its own.
    expect(free.mock.calls[0]![1] as string[]).toHaveLength(2);
    expect(await objectStore.list(inputPrefix("local", m.campaignId))).toEqual([]);
    expect(await counts(harness.db)).toEqual(snapshot);
    await expectSourcesUntouched({
      slug: source.slug,
      rows: ["extra.png", "logo.png"],
      objects: 2,
    });
  });

  test("create route still releases the campaign and answers the original error when the free fails under s3", async () => {
    const source = await seedSource(unique("src"));
    const snapshot = await counts(harness.db);
    watch();
    vi.spyOn(PgBriefStore.prototype, "createBrief").mockRejectedValueOnce(new Error("boom"));
    // The free is best-effort: it must never replace the original error.
    free.mockRejectedValueOnce(new Error("free failed"));
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const res = await createFrom(ONLY_T1, { name: unique("copy"), source: source.campaignId });
    expect(res.status).toBe(500);

    // The release ran despite the free's failure, so the reservation is gone again.
    expect(await counts(harness.db)).toEqual(snapshot);
    expect(warned).toHaveBeenCalledTimes(1);
    const m = await minted();
    const said = warned.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(said).toContain(`could not free the assets of "${m.slug}" after a failed create`);
    expect(said).toContain("free failed");
  });

  test("create route keeps every copy when the write succeeds under s3", async () => {
    const source = await seedSource(unique("src"));
    watch();
    const deleteAssets = vi.spyOn(ObjectAssetStore.prototype, "deleteAssets");

    const res = await createFrom(ONLY_T1, { name: unique("copy"), source: source.campaignId });
    expect(res.status).toBe(201);
    const m = await minted();
    expect(await res.json()).toEqual({
      campaignId: m.campaignId,
      slug: m.slug,
      revision: expect.any(String),
    });

    // Both copied assets survive: the version named logo.png, and extra.png (unreferenced).
    expect((await assetRows(m.campaignId)).sort()).toEqual(["extra.png", "logo.png"]);
    expect((await targetKeys(m.campaignId)).length).toBe(2);
    expect(free).not.toHaveBeenCalled();
    expect(deleteAssets).not.toHaveBeenCalled();
    const { rows: versions } = await harness.db.query<{ n: number }>(
      `select count(*)::int as n from brief_version where campaign_id = $1`,
      [m.campaignId],
    );
    expect(versions[0]!.n).toBe(1);
    await expectSourcesUntouched({
      slug: source.slug,
      rows: ["extra.png", "logo.png"],
      objects: 2,
    });
  });
});

/** The create compensation on pg plus fs (PT-9j1, D237): the create rollback frees only the files this request wrote, keeps a winning Save's, and re-checks the source after copying. */
describe("create compensation on pg plus fs", () => {
  const SAVED_OBJECT_STORE = process.env.OBJECT_STORE;
  const ORIG_ROOT = process.env.PROJECT_ROOT;
  const SAVED_BACKEND = process.env.STORE_BACKEND;
  let harness: PgHarness;
  let ownerStore: PgBriefStore;
  const SAVED = process.env.OBJECT_STORE;

  let seq = 0;
  const unique = (prefix: string): string => `${prefix}-${(seq += 1)}`;

  const minted = async () =>
    (await mint.mock.results[0]!.value) as { campaignId: string; slug: string };

  let mint: ReturnType<typeof vi.spyOn>;
  let seen: Map<string, ReadonlySet<string>>;
  let free: ReturnType<typeof vi.spyOn>;
  let copy: ReturnType<typeof vi.spyOn>;
  let deleteAssets: ReturnType<typeof vi.spyOn>;

  const watchFs = (interleave?: { hidden: string }) => {
    seen = new Map();
    mint = vi.spyOn(PgBriefStore.prototype, "createCampaign");
    const realCopy = FsAssetStore.prototype.copyAssets;
    copy = vi.spyOn(FsAssetStore.prototype, "copyAssets").mockImplementation(async function (
      this: FsAssetStore,
      from: string,
      to: string,
    ) {
      const result = await realCopy.call(this, from, to);
      if (!seen.has(from)) seen.set(from, result.created);
      if (interleave && from === interleave.hidden) {
        await harness.db.query(
          `update campaign set team_id = 't2' where org_id = 'local' and slug = $1`,
          [from],
        );
      }
      return result;
    });
    free = vi.spyOn(FsAssetStore.prototype, "freeUnreferencedAssets");
    deleteAssets = vi.spyOn(FsAssetStore.prototype, "deleteAssets");
    return { mint, seen, free, copy, deleteAssets };
  };

  const filesOf = (slug: string): string[] => {
    const dir = join(harness.projectRoot, "assets", "inputs", slug);
    return existsSync(dir)
      ? (readdirSync(dir, { recursive: true }) as string[]).slice().sort()
      : [];
  };

  const preHide = async (slug: string): Promise<void> => {
    await harness.db.query(
      `update campaign set team_id = 't2' where org_id = 'local' and slug = $1`,
      [slug],
    );
  };

  /** A t1 campaign with logo.png (PNG_ALT) and extra.png (PNG_ALT2), brief naming logo.png. */
  const seedSourcePgFs = async (prefix: string): Promise<{ slug: string; campaignId: string }> => {
    const slug = unique(prefix);
    const { campaignId } = await ownerStore.createCampaign(slug, { teamId: "t1" });
    await getAssetStore(ONLY_T1).writeAsset(slug, "logo.png", PNG_ALT);
    await getAssetStore(ONLY_T1).writeAsset(slug, "extra.png", PNG_ALT2);
    await ownerStore.createBrief(baseBrief(slug, pathRef(slug)), { teamId: "t1" });
    return { slug, campaignId };
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
    if (SAVED_OBJECT_STORE === undefined) delete process.env.OBJECT_STORE;
    else process.env.OBJECT_STORE = SAVED_OBJECT_STORE;
    if (SAVED_BACKEND === undefined) delete process.env.STORE_BACKEND;
    else process.env.STORE_BACKEND = SAVED_BACKEND;
    if (ORIG_ROOT === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = ORIG_ROOT;
    await harness.cleanup();
  });

  void SAVED;

  // --- Batch 4 (pg plus fs: delete process.env.OBJECT_STORE, FsAssetStore) ---

  test("create route on pg plus fs frees only the files it wrote when the write fails after the copy", async () => {
    const source = await seedSourcePgFs(unique("src"));
    const snapshot = await counts(harness.db);

    watchFs();
    vi.spyOn(PgBriefStore.prototype, "createBrief").mockRejectedValueOnce(new Error("boom"));

    const res = await createFrom(ONLY_T1, { name: unique("copy"), source: source.campaignId });
    expect(res.status).toBe(500);

    const m = await minted();
    expect(filesOf(m.slug)).toEqual([]);
    expect(filesOf(source.slug)).toEqual(["extra.png", "logo.png"]);
    expect(free).toHaveBeenCalledTimes(1);
    expect(free.mock.calls[0]![0]).toBe(m.slug);
    expect([...(free.mock.calls[0]![1] as string[])].sort()).toEqual(["extra.png", "logo.png"]);
    expect(deleteAssets).not.toHaveBeenCalled();
    expect((await counts(harness.db)).campaigns).toEqual(snapshot.campaigns);
  });

  test("create route on pg plus fs keeps the files of a winning Save and frees nothing", async () => {
    const source = await seedSourcePgFs(unique("src"));
    watchFs();
    const real = PgBriefStore.prototype.createBrief;
    vi.spyOn(PgBriefStore.prototype, "createBrief").mockImplementationOnce(
      async (body, options) => {
        await real.call(
          new PgBriefStore(harness.db, "local", "other-instance", ["owner"], []),
          baseBrief(body.id, pathRef(body.id)),
          options,
        );
        throw Object.assign(new Error(`Brief "${body.id}" already exists.`), { code: "EEXIST" });
      },
    );

    const res = await createFrom(ONLY_T1, { name: unique("copy"), source: source.campaignId });
    expect(res.status).toBe(409);
    const m = await minted();
    expect(await res.json()).toEqual({ error: `Brief "${m.slug}" already exists.` });

    expect(filesOf(m.slug)).toEqual(["extra.png", "logo.png"]);
    expect(free).not.toHaveBeenCalled();
    expect(deleteAssets).not.toHaveBeenCalled();
  });

  test("create route on pg plus fs refuses and frees the source copy when the source is reassigned after its copy", async () => {
    const source = await seedSourcePgFs(unique("src"));
    const snapshot = await counts(harness.db);

    watchFs({ hidden: source.slug });

    const res = await createFrom(ONLY_T1, { name: unique("copy"), source: source.campaignId });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body).toEqual({ error: `Brief "${source.campaignId}" not found.` });

    await preHide(source.slug);
    const res2 = await createFrom(ONLY_T1, { name: unique("again"), source: source.campaignId });
    expect(res2.status).toBe(404);
    expect(await res2.json()).toEqual(body);
    expect(body.error).not.toContain(source.slug);

    const m = await minted();
    expect(filesOf(m.slug)).toEqual([]);
    expect(free).toHaveBeenCalledTimes(1);
    expect([...(free.mock.calls[0]![1] as string[])].sort()).toEqual(["extra.png", "logo.png"]);
    expect(filesOf(source.slug)).toEqual(["extra.png", "logo.png"]);
    expect((await counts(harness.db)).campaigns).toEqual(snapshot.campaigns);
  });

  // --- Batch 5 (the guard's two non-free outcomes, on pg plus fs) ---

  test("create route on pg plus fs still releases the campaign and warns when campaignMeta rejects after the copy", async () => {
    const source = await seedSourcePgFs(unique("src"));
    const snapshot = await counts(harness.db);

    watchFs();
    // Arming the campaignMeta spy INSIDE the createBrief stub makes the rollback's later call
    // the one it answers, not an earlier campaignMeta in the request.
    vi.spyOn(PgBriefStore.prototype, "createBrief").mockImplementationOnce(async () => {
      vi.spyOn(PgBriefStore.prototype, "campaignMeta").mockRejectedValueOnce(
        new Error("meta failed"),
      );
      throw new Error("boom");
    });
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const res = await createFrom(ONLY_T1, { name: unique("copy"), source: source.campaignId });
    expect(res.status).toBe(500);
    // campaignMeta threw, so free was never reached; the warn is what records it.
    expect(free).not.toHaveBeenCalled();
    expect(await counts(harness.db)).toEqual(snapshot);
    expect(warned).toHaveBeenCalledTimes(1);
    const m = await minted();
    const said = warned.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(said).toContain(`could not free the assets of "${m.slug}" after a failed create`);
    expect(said).toContain("meta failed");
  });

  test("create route on pg plus fs still releases the campaign when campaignMeta answers undefined", async () => {
    const source = await seedSourcePgFs(unique("src"));
    const snapshot = await counts(harness.db);

    watchFs();
    vi.spyOn(PgBriefStore.prototype, "createBrief").mockImplementationOnce(async () => {
      vi.spyOn(PgBriefStore.prototype, "campaignMeta").mockResolvedValueOnce(undefined);
      throw new Error("boom");
    });
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const res = await createFrom(ONLY_T1, { name: unique("copy"), source: source.campaignId });
    expect(res.status).toBe(500);
    // campaignMeta answered undefined: the `?.` short-circuits to undefined, the guard is
    // false, free is skipped, and nothing warns.
    expect(free).not.toHaveBeenCalled();
    expect(await counts(harness.db)).toEqual(snapshot);
    expect(warned).not.toHaveBeenCalled();
  });
});

/** The create compensation on fs only (PT-9j1: fs has no teams, so no visibility call and free by path). */
describe("create compensation on fs only", () => {
  const SAVED_OBJECT_STORE = process.env.OBJECT_STORE;
  const SAVED_BACKEND = process.env.STORE_BACKEND;
  const ORIG_ROOT = process.env.PROJECT_ROOT;
  let harness: FsHarness;

  let seq = 0;
  const unique = (prefix: string): string => `${prefix}-${(seq += 1)}`;

  const minted = async () =>
    (await mint.mock.results[0]!.value) as { campaignId: string; slug: string };

  let mint: ReturnType<typeof vi.spyOn>;
  let seen: Map<string, ReadonlySet<string>>;
  let free: ReturnType<typeof vi.spyOn>;
  let copy: ReturnType<typeof vi.spyOn>;
  let deleteAssets: ReturnType<typeof vi.spyOn>;

  const watchFs = () => {
    seen = new Map();
    mint = vi.spyOn(FsBriefStore.prototype, "createCampaign");
    const realCopy = FsAssetStore.prototype.copyAssets;
    copy = vi.spyOn(FsAssetStore.prototype, "copyAssets").mockImplementation(async function (
      this: FsAssetStore,
      from: string,
      to: string,
    ) {
      const result = await realCopy.call(this, from, to);
      if (!seen.has(from)) seen.set(from, result.created);
      return result;
    });
    free = vi.spyOn(FsAssetStore.prototype, "freeUnreferencedAssets");
    deleteAssets = vi.spyOn(FsAssetStore.prototype, "deleteAssets");
    return { mint, seen, free, copy, deleteAssets };
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

  test("create route on fs frees the files it wrote and makes no visibility call when the write fails after the copy", async () => {
    const briefStore = getBriefStore(LOCAL_TENANT);
    const assetStore = getAssetStore(LOCAL_TENANT);
    const source = unique("src");
    await briefStore.createCampaign(source);
    await assetStore.writeAsset(source, "logo.png", PNG_ALT);
    await briefStore.createBrief(baseBrief(source, pathRef(source)));

    watchFs();
    vi.spyOn(FsBriefStore.prototype, "createBrief").mockRejectedValueOnce(new Error("boom"));
    const visibility = vi.spyOn(FsBriefStore.prototype, "campaignVisibility");

    const res = await createFrom(LOCAL_TENANT, { name: unique("copy"), source });
    expect(res.status).toBe(500);

    const m = await minted();
    expect(visibility).not.toHaveBeenCalled();
    expect(free).toHaveBeenCalledTimes(1);
    expect(free.mock.calls[0]![0]).toBe(m.slug);
    expect([...(free.mock.calls[0]![1] as string[])].sort()).toEqual(["logo.png"]);
    expect(deleteAssets).not.toHaveBeenCalled();
    expect(filesOf(m.slug)).toEqual([]);
    expect(filesOf(source)).toEqual(["logo.png"]);
    expect(await briefStore.campaignMeta(m.slug)).toBeUndefined();
  });
});
