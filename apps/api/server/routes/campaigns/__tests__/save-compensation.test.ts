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
import { getAssetStore, getBriefStore, resetAssetStore } from "../../../lib/ports/index.js";
import { FsAssetStore } from "../../../lib/ports/fs-asset-store.js";
import { ObjectAssetStore } from "../../../lib/ports/object-asset-store.js";
import type { CopyAssetsOptions } from "../../../lib/ports/asset-store.port.js";
import { PgBriefStore } from "../../../lib/ports/pg-brief-store.js";
import type { SqlClient } from "../../../lib/db/sql-client.js";
import type { TenantContext } from "../../../lib/tenant.js";
import {
  LOCAL_TENANT,
  mountTenantRoute,
  setupFsHarness,
  setupPgHarness,
  type PgHarness,
} from "../../__tests__/tenant-harness.js";
import { FsBriefStore } from "../../../lib/ports/fs-brief-store.js";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import assetsPostHandler from "../assets.post.js";
import briefsPostHandler from "../briefs.post.js";

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

describe("save route compensation (s3 on pg)", () => {
  let harness: PgHarness;
  let objectStore: InMemoryObjectStore;
  let ownerStore: PgBriefStore;
  let seq = 0;
  const unique = (prefix: string): string => `${prefix}-${(seq += 1)}`;
  const SAVED_OBJECT_STORE = process.env.OBJECT_STORE;

  const store = () => getAssetStore(ONLY_T1);

  /** A campaign of its own, uploaded to, and — for PUT — versioned. */
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

  /** Installs spies on the s3 adapter's copy/free/delete, recording the FIRST write of each
   * source's `created` set (a competing writer that reuses by sha256 gets an all-reused empty
   * set, which must never overwrite this request's record). */
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

  test("save route frees exactly the ids it created when the first Save fails after the copy under s3", async () => {
    const { slug, ownId } = await freshTarget(false);
    const source = await seedSource();
    const targetUuid = await uuidOf(slug);
    const snapshot = await counts(harness.db);
    const { seen, free, del } = watch();
    vi.spyOn(PgBriefStore.prototype, "createBrief").mockRejectedValueOnce(new Error("boom"));

    const res = await post(ONLY_T1, allForeignId(slug, source.ids.alt));
    expect(res.status).toBe(500);

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
    const srcUuid = await uuidOf(source.slug);
    expect(await assetRows(srcUuid)).toHaveLength(3);
    expect(await keysOf(source.slug)).toHaveLength(3);
  });

  test("save route frees exactly the ids it created when a replace loses a revision race after the copy under s3", async () => {
    const { slug, ownId } = await freshTarget(true);
    const source = await seedSource();
    const targetUuid = await uuidOf(slug);
    const snapshot = await counts(harness.db);
    const { seen, free, del } = watch();
    vi.spyOn(PgBriefStore.prototype, "replaceBrief").mockRejectedValueOnce(
      Object.assign(new Error("Brief was modified by another user."), {
        code: "ECONFLICT",
        revision: "r-newer",
      }),
    );

    const res = await post(ONLY_T1, allForeignId(slug, source.ids.alt), "?replace=1");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Brief was modified by another user.",
      revision: "r-newer",
    });

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

  test("save route keeps what a winning Save reused and named and frees the rest when it loses the slug under s3", async () => {
    const target = await freshTarget(false);
    const source = await seedSource();
    const targetUuid = await uuidOf(target.slug);
    const snapshot = await counts(harness.db);
    const { seen, free } = watch();

    const realCreate = PgBriefStore.prototype.createBrief;
    let altTargetId!: string;
    vi.spyOn(PgBriefStore.prototype, "createBrief").mockImplementationOnce(
      async (brief, options) => {
        altTargetId = (
          await harness.db.query<{ id: string }>(
            `select id from asset where org_id = 'local' and campaign_id = $1 and name = $2`,
            [targetUuid, "alt.png"],
          )
        ).rows[0].id;
        // The winner's own copy REUSES the request's rows by sha256.
        const reused = await new ObjectAssetStore(harness.db, objectStore, "local").copyAssets(
          source.slug,
          target.slug,
          { only: ["alt.png"] },
        );
        expect([...reused.created]).toEqual([]);
        const other = new PgBriefStore(harness.db, "local", "other-instance", ["owner"], [], true);
        await realCreate.call(other, baseBrief(target.slug, altTargetId), options);
        throw Object.assign(new Error(`Brief "${target.slug}" already exists.`), {
          code: "EEXIST",
        });
      },
    );

    const res = await post(ONLY_T1, {
      ...allForeignId(target.slug, source.ids.alt),
      audio: { path: source.ids.bg, rights: { licenceId: "lic-1", source: "library" } },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: `Brief "${target.slug}" already exists.` });

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

  test("save route frees every copy when the post-copy ref check refuses under s3", async () => {
    const { slug, ownId } = await freshTarget(false);
    const source = await seedSource();
    const srcUuid = await uuidOf(source.slug);
    const snapshot = await counts(harness.db);
    const real = ObjectAssetStore.prototype.copyAssets;
    const { copy, seen, free, del } = watch();
    copy.mockImplementationOnce(async function (
      this: ObjectAssetStore,
      from: string,
      to: string,
      options?: CopyAssetsOptions,
    ) {
      // The brief names alt and bg; drop the source row the brief names (alt.png)
      // before the real copy, so the copy brings over only bg.png — the alt ref the
      // brief carries survives unmapped and `assertRefsCopied` refuses.
      await harness.db.query(
        `delete from asset where org_id = 'local' and campaign_id = $1 and name = $2`,
        [srcUuid, "alt.png"],
      );
      const r = await real.call(this, from, to, options);
      seen.set(from, r.created);
      return r;
    });

    const res = await post(ONLY_T1, {
      ...allForeignId(slug, source.ids.alt),
      audio: { path: source.ids.bg, rights: { licenceId: "lic-1", source: "library" } },
    });
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toEqual({
      error: `Campaign "${slug}" not found`,
    });

    expect(free).toHaveBeenCalledTimes(1);
    expect([...(free.mock.calls[0][1] as readonly string[])].sort()).toEqual(
      [...(seen.get(source.slug) ?? new Set<string>())].sort(),
    );
    expect(del).not.toHaveBeenCalled();
    expect(await rowsOf(slug)).toEqual([{ id: ownId, name: "logo.png" }]);
    expect((await keysOf(slug)).length).toBe(1);
    expect((await counts(harness.db)).versions).toBe(snapshot.versions);
  });

  test("save route answers the original error and logs nothing when the free fails under s3", async () => {
    const { slug } = await freshTarget(false);
    const source = await seedSource();
    const { free, del } = watch();
    free.mockRejectedValueOnce(new Error("free failed"));
    vi.spyOn(PgBriefStore.prototype, "createBrief").mockRejectedValueOnce(
      Object.assign(new Error(`Brief "${slug}" already exists.`), { code: "EEXIST" }),
    );
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errored = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await post(ONLY_T1, allForeignId(slug, source.ids.alt));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: `Brief "${slug}" already exists.` });

    expect(free).toHaveBeenCalledTimes(1);
    expect(del).not.toHaveBeenCalled();
    expect((await rowsOf(slug)).map((r) => r.name).sort()).toEqual(["alt.png", "logo.png"]);
    expect((await keysOf(slug)).length).toBe(2);
    expect(warned).not.toHaveBeenCalled();
    expect(errored).not.toHaveBeenCalled();
  });

  test("save route does not call the free when nothing was copied under s3", async () => {
    const { slug, ownId } = await freshTarget(false);
    const targetUuid = await uuidOf(slug);
    const snapshot = await counts(harness.db);
    const { copy, free, del } = watch();
    vi.spyOn(PgBriefStore.prototype, "createBrief").mockRejectedValueOnce(new Error("boom"));

    // Every ref is the target's OWN id: nothing to copy.
    const res = await post(ONLY_T1, baseBrief(slug, ownId));
    expect(res.status).toBe(500);

    expect(copy).not.toHaveBeenCalled();
    expect(free).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect((await assetRows(targetUuid)).length).toBe(1);
    expect((await keysOf(slug)).length).toBe(1);
    expect((await counts(harness.db)).versions).toBe(snapshot.versions);
  });

  test("save route keeps every copy when the write succeeds under s3", async () => {
    const { slug } = await freshTarget(false);
    const source = await seedSource();
    const targetUuid = await uuidOf(slug);
    const snapshot = await counts(harness.db);
    const { free, del } = watch();

    const res = await post(ONLY_T1, allForeignId(slug, source.ids.alt));
    expect(res.status).toBe(201);
    const stored = ((await res.json()) as { brief: CampaignBrief }).brief;
    const refs = storedRefs(stored);
    expect(refs).toHaveLength(1);
    for (const ref of refs) {
      const owner = await store().assetOwner(ref);
      expect(owner?.slug).toBe(slug);
    }
    expect((await assetRows(targetUuid)).sort()).toEqual(["alt.png", "logo.png"]);
    expect((await keysOf(slug)).length).toBe(2);
    expect(free).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect((await counts(harness.db)).versions).toBe(snapshot.versions + 1);
  });

  test("save route maps an ERESERVED from createBrief to a 400 and frees nothing under s3", async () => {
    const { slug } = await freshTarget(false);
    const snapshot = await counts(harness.db);
    const { seen, free, del } = watch();
    vi.spyOn(PgBriefStore.prototype, "createBrief").mockRejectedValueOnce(
      Object.assign(new Error(`"${slug}" is reserved; choose another campaign id.`), {
        code: "ERESERVED",
      }),
    );

    const res = await post(ONLY_T1, baseBrief(slug, pathRef(slug)));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: `"${slug}" is reserved; choose another campaign id.`,
    });

    expect(seen.size).toBe(0);
    expect(free).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect((await counts(harness.db)).versions).toBe(snapshot.versions);
  });
});

describe("save route compensation on pg plus fs", () => {
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

  const filesOf = (slug: string): string[] => {
    try {
      return [
        ...(readdirSync(join(harness.projectRoot, "assets", "inputs", slug), {
          recursive: true,
        }) as string[]),
      ].sort();
    } catch {
      return [];
    }
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
    if (SAVED_ROOT === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = SAVED_ROOT;
    await harness.cleanup();
  });

  test("save route on pg plus fs frees only the files it wrote and keeps the target own and reused files when the write fails", async () => {
    const sourceSlug = unique("source-pgfs");
    const targetSlug = unique("target-pgfs");
    await ownerStore.createCampaign(sourceSlug, { teamId: "t1" });
    await store().writeAsset(sourceSlug, "logo.png", PNG);
    await store().writeAsset(sourceSlug, "alt.png", PNG_ALT);
    await store().writeAsset(sourceSlug, "bg.png", PNG_ALT2);
    // Versionless target of its own: own logo.png = PNG (a sha-deduped reuse of the
    // source's logo) and its own mine.png.
    await ownerStore.createCampaign(targetSlug, { teamId: "t1" });
    await store().writeAsset(targetSlug, "logo.png", PNG);
    await store().writeAsset(targetSlug, "mine.png", Buffer.concat([PNG, Buffer.from([0x01])]));

    const snapshot = await counts(harness.db);
    const free = vi.spyOn(FsAssetStore.prototype, "freeUnreferencedAssets");
    const del = vi.spyOn(FsAssetStore.prototype, "deleteAssets");
    vi.spyOn(PgBriefStore.prototype, "createBrief").mockRejectedValueOnce(new Error("boom"));

    const res = await post(
      ONLY_T1,
      allForeignId(targetSlug, `assets/inputs/${sourceSlug}/alt.png`),
    );
    expect(res.status).toBe(500);

    expect(free).toHaveBeenCalledTimes(1);
    expect(free.mock.calls[0][0]).toBe(targetSlug);
    expect([...(free.mock.calls[0][1] as readonly string[])].sort()).toEqual(["alt.png"]);
    expect(del).not.toHaveBeenCalled();
    expect(await filesOf(targetSlug)).toEqual(["logo.png", "mine.png"]);
    expect(await store().readAsset(targetSlug, "logo.png")).toEqual(PNG);
    expect((await counts(harness.db)).versions).toBe(snapshot.versions);
    expect((await namesOf(sourceSlug)).sort()).toEqual(["alt.png", "bg.png", "logo.png"]);
  });
});

describe("save route compensation on fs", () => {
  const SAVED_OBJECT_STORE = process.env.OBJECT_STORE;
  const SAVED_BACKEND = process.env.STORE_BACKEND;
  const SAVED_ROOT = process.env.PROJECT_ROOT;
  let harness: ReturnType<typeof setupFsHarness>;
  let seq = 0;
  const unique = (prefix: string): string => `${prefix}-${(seq += 1)}`;

  const namesOf = async (briefId: string): Promise<string[]> =>
    (await getAssetStore(LOCAL_TENANT).listAssets(briefId)).map((a) => a.name);

  const filesOf = (slug: string): string[] => {
    try {
      return [
        ...(readdirSync(join(harness.projectRoot, "assets", "inputs", slug), {
          recursive: true,
        }) as string[]),
      ].sort();
    } catch {
      return [];
    }
  };

  beforeAll(() => {
    setCapabilities({ motion: true });
    delete process.env.OBJECT_STORE;
    harness = setupFsHarness();
  });

  afterEach(() => {
    resetAssetStore();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    setCapabilities({ motion: false, reason: "not probed" });
    if (SAVED_OBJECT_STORE === undefined) delete process.env.OBJECT_STORE;
    else process.env.OBJECT_STORE = SAVED_OBJECT_STORE;
    if (SAVED_BACKEND === undefined) delete process.env.STORE_BACKEND;
    else process.env.STORE_BACKEND = SAVED_BACKEND;
    if (SAVED_ROOT === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = SAVED_ROOT;
    harness.cleanup();
  });

  test("save route on fs frees only the files it wrote when the write fails after the copy", async () => {
    const sourceSlug = unique("source-fs");
    const targetSlug = unique("target-fs");
    await getBriefStore(LOCAL_TENANT).createCampaign(sourceSlug);
    await getAssetStore(LOCAL_TENANT).writeAsset(sourceSlug, "alt.png", PNG_ALT);
    await getBriefStore(LOCAL_TENANT).createCampaign(targetSlug);
    await getAssetStore(LOCAL_TENANT).writeAsset(targetSlug, "logo.png", PNG);

    const free = vi.spyOn(FsAssetStore.prototype, "freeUnreferencedAssets");
    const del = vi.spyOn(FsAssetStore.prototype, "deleteAssets");
    vi.spyOn(FsBriefStore.prototype, "createBrief").mockRejectedValueOnce(new Error("boom"));

    const res = await post(
      LOCAL_TENANT,
      allForeignId(targetSlug, `assets/inputs/${sourceSlug}/alt.png`),
    );
    expect(res.status).toBe(500);

    expect(free).toHaveBeenCalledTimes(1);
    expect(free.mock.calls[0][0]).toBe(targetSlug);
    expect([...(free.mock.calls[0][1] as readonly string[])].sort()).toEqual(["alt.png"]);
    expect(del).not.toHaveBeenCalled();
    expect(await filesOf(targetSlug)).toEqual(["logo.png"]);
    expect(await getAssetStore(LOCAL_TENANT).readAsset(targetSlug, "logo.png")).toEqual(PNG);
    expect((await namesOf(sourceSlug)).sort()).toEqual(["alt.png"]);
  });
});
