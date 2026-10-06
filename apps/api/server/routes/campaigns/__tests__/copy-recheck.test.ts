import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
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
import { FsBriefStore } from "../../../lib/ports/fs-brief-store.js";
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
import briefsPostHandler from "../briefs.post.js";
import briefsPutHandler from "../briefs/[id].put.js";
import duplicatePostHandler from "../briefs/[id]/duplicate.post.js";
import indexPostHandler from "../index.post.js";

/**
 * `copyBriefRefs`' post-copy re-check under the route (PT-9i, D237): when a source is
 * reassigned between the copy and the re-check, each write route answers the SAME 404 its
 * resolve-time refusal already gives and leaves no copied bytes behind — the free lives
 * INSIDE `copyBriefRefs`, which is what makes that hold for `briefs.post` and PUT, where
 * the routes themselves have no rollback.
 */

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_ALT = Buffer.concat([PNG, Buffer.from([0x00])]);

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

describe("the write routes re-check their copy sources after copying (PT-9i, D237)", () => {
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

  /** A visible foreign campaign of its own, with a differently-bitted upload. */
  const freshSource = async (): Promise<{ slug: string; id: string }> => {
    const slug = unique("source");
    await ownerStore.createCampaign(slug, { teamId: "t1" });
    return { slug, id: await upload(OWNER, slug, "logo.png", PNG_ALT) };
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

  /** Wrap the real `copyAssets` so that, after a source's copy returns, its campaign is reassigned to t2. No `campaignVisibility` is mocked: the real adapter reads the real row afterwards. Returns the spy so a test can assert the copy really ran. */
  const reassignDuringCopy = (hiddenSlug: string): ReturnType<typeof vi.spyOn> => {
    const real = ObjectAssetStore.prototype.copyAssets;
    return vi.spyOn(ObjectAssetStore.prototype, "copyAssets").mockImplementation(async function (
      this: ObjectAssetStore,
      from: string,
      to: string,
    ) {
      const result = await real.call(this, from, to);
      if (from === hiddenSlug) {
        await harness.db.query(
          `update campaign set team_id = 't2' where org_id = 'local' and slug = $1`,
          [hiddenSlug],
        );
      }
      return result;
    });
  };

  /** Pre-hide a source (reassign before the request) to capture the resolve-time-hidden 404 for byte-for-byte comparison. */
  const preHide = async (slug: string): Promise<void> => {
    await harness.db.query(
      `update campaign set team_id = 't2' where org_id = 'local' and slug = $1`,
      [slug],
    );
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

  const expectNoRows = async (before: Counts): Promise<void> => {
    expect(await counts(harness.db)).toEqual(before);
  };

  test("briefs.post answers the one 404 and leaves no copied row or object when the source is reassigned mid-request", async () => {
    const { slug, ownId } = await freshTarget(false);
    const { slug: srcSlug, id: srcId } = await freshSource();
    const snapshot = await counts(harness.db);

    // The copy runs, then the re-check refuses (mid-request reassignment).
    const copied = reassignDuringCopy(srcSlug);
    const res = await post(ONLY_T1, allForeignId(slug, srcId));
    expect(res.status).toBe(404);
    const recheckBody = (await res.json()) as { error: string };

    // The SAME route with the source ALREADY hidden answers the SAME s3 404 body — D210(c)'s
    // whole point — so hidden and the post-copy race are indistinguishable. The source is
    // already hidden from the reassignment above, so `preHide` is idempotent here.
    await preHide(srcSlug);
    const hidden = await post(ONLY_T1, allForeignId(slug, srcId));
    expect(hidden.status).toBe(404);
    expect(recheckBody).toEqual(await hidden.json());

    // The exact body: `Campaign "<brief.id>" not found` (the caller's own target), no source slug.
    expect(recheckBody).toEqual({ error: `Campaign "${slug}" not found` });
    expect(recheckBody.error).not.toContain(srcSlug);
    // The copy REALLY happened; "nothing left" is a result of the free, not a skipped copy.
    expect(copied).toHaveBeenCalled();
    // No version was written (the refusal sits before createBrief).
    await expectNoRows(snapshot);

    // State: the target holds only its own logo row and key.
    const targetUuid = await uuidOf(slug);
    expect(await assetRows(targetUuid)).toEqual(["logo.png"]);
    expect(await targetKeys(targetUuid)).toEqual([inputKey("local", targetUuid, ownId)]);
    // The source still holds all of its rows/objects.
    const srcUuid = await uuidOf(srcSlug);
    expect((await assetRows(srcUuid)).length).toBe(1);
    expect((await targetKeys(srcUuid)).length).toBe(1);
  });

  test("briefs.put answers the one 404 and leaves no copied row or object when the source is reassigned mid-request", async () => {
    const { slug, ownId } = await freshTarget(true);
    const { slug: srcSlug, id: srcId } = await freshSource();
    const snapshot = await counts(harness.db);

    const copied = reassignDuringCopy(srcSlug);
    const res = await put(ONLY_T1, slug, allForeignId(slug, srcId));
    expect(res.status).toBe(404);
    const recheckBody = (await res.json()) as { error: string };

    await preHide(srcSlug);
    const hidden = await put(ONLY_T1, slug, allForeignId(slug, srcId));
    expect(hidden.status).toBe(404);
    expect(recheckBody).toEqual(await hidden.json());

    expect(recheckBody).toEqual({ error: `Brief "${slug}" not found.` });
    expect(recheckBody.error).not.toContain(srcSlug);
    expect(copied).toHaveBeenCalled();
    await expectNoRows(snapshot);

    const targetUuid = await uuidOf(slug);
    expect(await assetRows(targetUuid)).toEqual(["logo.png"]);
    expect(await targetKeys(targetUuid)).toEqual([inputKey("local", targetUuid, ownId)]);
    const srcUuid = await uuidOf(srcSlug);
    expect((await assetRows(srcUuid)).length).toBe(1);
  });

  /** A source brief whose logoPath names `ref` (the THIRD campaign's id). Seeded as OWNER with the s3 flag OFF so `createBrief` does not validate the foreign id against the source's own rows. */
  const seedSourceBrief = async (
    ref: string,
    prefix: string,
  ): Promise<{ slug: string; campaignId: string }> => {
    const slug = unique(prefix);
    const { campaignId } = await ownerStore.createCampaign(slug, { teamId: "t1" });
    await upload(OWNER, slug, "logo.png", PNG_ALT);
    await ownerStore.createBrief(
      {
        ...baseBrief(slug, pathRef(slug)),
        products: [{ id: "p1", name: "P1", primaryColor: "#1473E3", logoPath: ref }],
      },
      { teamId: "t1" },
    );
    return { slug, campaignId };
  };

  test("duplicate answers the one 404 and leaves no campaign when the third campaign is reassigned mid-request", async () => {
    const third = await freshSource();
    const { slug: srcSlug, campaignId } = await seedSourceBrief(third.id, "src-recheck-dup");
    const snapshot = await counts(harness.db);

    // The copy runs (the source's own assets AND the third's via copyBriefRefs), then the
    // re-check refuses once the third is reassigned.
    const copied = reassignDuringCopy(third.slug);
    const res = await duplicate(ONLY_T1, campaignId, unique("copy"));
    expect(res.status).toBe(404);
    const recheckBody = (await res.json()) as { error: string };

    // The SAME route with the third ALREADY hidden answers the SAME s3 404 body — the
    // refusal is `Brief "<router id>" not found.` either way (D210(c)). The third is already
    // hidden from the reassignment above, so `preHide` is idempotent here.
    await preHide(third.slug);
    const hidden = await duplicate(ONLY_T1, campaignId, unique("hidden-copy"));
    expect(hidden.status).toBe(404);
    expect(recheckBody).toEqual(await hidden.json());

    expect(recheckBody).toEqual({ error: `Brief "${campaignId}" not found.` });
    expect(recheckBody.error).not.toContain(third.slug);
    expect(copied).toHaveBeenCalled();
    // The existing rollback frees the source's own copy; the new free frees the third's —
    // together they leave zero net rows (no version, no minted campaign, no copied assets).
    await expectNoRows(snapshot);
    const thirdUuid = await uuidOf(third.slug);
    expect((await assetRows(thirdUuid)).length).toBe(1);
    expect((await targetKeys(thirdUuid)).length).toBe(1);
  });

  test("index.post answers the one 404 and leaves no campaign when the third campaign is reassigned mid-request", async () => {
    const third = await freshSource();
    const { campaignId } = await seedSourceBrief(third.id, "src-recheck-create");
    const snapshot = await counts(harness.db);

    const copied = reassignDuringCopy(third.slug);
    const res = await createFrom(ONLY_T1, { name: unique("copy"), source: campaignId });
    expect(res.status).toBe(404);
    const recheckBody = (await res.json()) as { error: string };

    await preHide(third.slug);
    const hidden = await createFrom(ONLY_T1, { name: unique("hidden-copy"), source: campaignId });
    expect(hidden.status).toBe(404);
    expect(recheckBody).toEqual(await hidden.json());

    expect(recheckBody).toEqual({ error: `Brief "${campaignId}" not found.` });
    expect(recheckBody.error).not.toContain(third.slug);
    expect(copied).toHaveBeenCalled();
    await expectNoRows(snapshot);
    const thirdUuid = await uuidOf(third.slug);
    expect((await assetRows(thirdUuid)).length).toBe(1);
    expect((await targetKeys(thirdUuid)).length).toBe(1);
  });

  test("briefs.post with a source that stays visible still answers 201 and keeps its copies", async () => {
    // Control: no reassignment, so the re-check is clean and nothing is freed.
    const { slug, ownId } = await freshTarget(false);
    const { slug: srcSlug, id: srcId } = await freshSource();

    const res = await post(ONLY_T1, allForeignId(slug, srcId));
    expect(res.status).toBe(201);
    const stored = (await res.json()).brief as CampaignBrief;
    const refs = storedRefs(stored);
    expect(refs).toHaveLength(1);
    expect(refs[0]).not.toBe(srcId);
    expect((await store().assetOwner(refs[0]!))?.slug).toBe(slug);
    // The stored ref remapped onto the target, so it owns a row under it.
    const targetUuid = await uuidOf(slug);
    expect((await assetRows(targetUuid)).length).toBe(2);
    // The source's own logo is untouched.
    const srcUuid = await uuidOf(srcSlug);
    expect((await assetRows(srcUuid)).length).toBe(1);
  });
});

describe("copyBriefRefs on pg plus fs re-checks by team and frees by path (PT-9i, D237)", () => {
  const SAVED_OBJECT_STORE = process.env.OBJECT_STORE;
  const ORIG_ROOT = process.env.PROJECT_ROOT;
  const SAVED_BACKEND = process.env.STORE_BACKEND;
  let harness: PgHarness;
  let ownerStore: PgBriefStore;
  let seq = 0;
  const unique = (prefix: string): string => `${prefix}-${(seq += 1)}`;

  const store = () => getAssetStore(ONLY_T1);

  const freshTarget = async (): Promise<{ slug: string }> => {
    const slug = unique("target-pgfs");
    await ownerStore.createCampaign(slug, { teamId: "t1" });
    await store().writeAsset(slug, "logo.png", PNG);
    return { slug };
  };

  const freshSource = async (): Promise<{ slug: string }> => {
    const slug = unique("source-pgfs");
    await ownerStore.createCampaign(slug, { teamId: "t1" });
    await store().writeAsset(slug, "alt.png", PNG_ALT);
    return { slug };
  };

  /** A source brief whose logoPath names `ref` (the THIRD campaign's asset), under pg+fs a PATH ref. */
  const seedSourceBrief = async (
    ref: string,
    prefix: string,
  ): Promise<{ slug: string; campaignId: string }> => {
    const slug = unique(prefix);
    const { campaignId } = await ownerStore.createCampaign(slug, { teamId: "t1" });
    await store().writeAsset(slug, "logo.png", PNG_ALT);
    await ownerStore.createBrief(
      {
        ...baseBrief(slug, pathRef(slug)),
        products: [{ id: "p1", name: "P1", primaryColor: "#1473E3", logoPath: ref }],
      },
      { teamId: "t1" },
    );
    return { slug, campaignId };
  };

  /** Like `reassignDuringCopy` but on the fs store the pg+fs backend actually uses. */
  const reassignDuringCopy = (hiddenSlug: string): void => {
    const real = FsAssetStore.prototype.copyAssets;
    vi.spyOn(FsAssetStore.prototype, "copyAssets").mockImplementation(async function (
      this: FsAssetStore,
      from: string,
      to: string,
    ) {
      const result = await real.call(this, from, to);
      if (from === hiddenSlug) {
        await harness.db.query(
          `update campaign set team_id = 't2' where org_id = 'local' and slug = $1`,
          [hiddenSlug],
        );
      }
      return result;
    });
  };

  const preHide = async (slug: string): Promise<void> => {
    await harness.db.query(
      `update campaign set team_id = 't2' where org_id = 'local' and slug = $1`,
      [slug],
    );
  };

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
    if (SAVED_OBJECT_STORE === undefined) delete process.env.OBJECT_STORE;
    else process.env.OBJECT_STORE = SAVED_OBJECT_STORE;
    if (SAVED_BACKEND === undefined) delete process.env.STORE_BACKEND;
    else process.env.STORE_BACKEND = SAVED_BACKEND;
    if (ORIG_ROOT === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = ORIG_ROOT;
    await harness.cleanup();
  });

  test("briefs.post on pg plus fs answers the one 404 and leaves no copied file when the source is reassigned mid-request", async () => {
    const { slug: target } = await freshTarget();
    const { slug: srcSlug } = await freshSource();
    const body = {
      ...baseBrief(target, pathRef(target)),
      products: [
        {
          id: "p1",
          name: "P1",
          primaryColor: "#1473E3",
          logoPath: `assets/inputs/${srcSlug}/alt.png`,
        },
      ],
    };
    const free = vi.spyOn(FsAssetStore.prototype, "freeUnreferencedAssets");

    // Re-check refusal: the copy ran, then the re-check refuses.
    reassignDuringCopy(srcSlug);
    const res = await post(ONLY_T1, body);
    expect(res.status).toBe(404);
    const recheckBody = (await res.json()) as { error: string };
    // Off s3 the re-check maps to `Campaign "<brief.id>" not found` — the caller's own target.
    expect(recheckBody).toEqual({ error: `Campaign "${target}" not found` });
    expect(recheckBody.error).not.toContain(srcSlug);
    expect(free).toHaveBeenCalledTimes(1);
    expect([...free.mock.calls[0]![1]].sort()).toEqual(["alt.png"]);
    expect(await namesOf(target)).toEqual(["logo.png"]);
    expect(await store().readAsset(target, "alt.png")).toBeUndefined();

    // Resolve-time-hidden: the SAME request, source pre-hidden. Off s3 the resolve-time
    // refusal is a PLAIN CampaignNotFoundError naming the SOURCE (decision 4), so the body
    // differs from the re-check one by design.
    await preHide(srcSlug);
    const hidden = await post(ONLY_T1, body);
    expect(hidden.status).toBe(404);
    expect((await hidden.json()) as { error: string }).toEqual({
      error: `Campaign "${srcSlug}" not found`,
    });
  });

  test("duplicate on pg plus fs answers the one 404 and leaves no campaign files when the third campaign is reassigned mid-request", async () => {
    const third = await freshSource();
    const { campaignId } = await seedSourceBrief(
      `assets/inputs/${third.slug}/alt.png`,
      "src-dup-pgfs",
    );
    const snapshot = await counts(harness.db);

    reassignDuringCopy(third.slug);
    const free = vi.spyOn(FsAssetStore.prototype, "freeUnreferencedAssets");

    const res = await duplicate(ONLY_T1, campaignId, unique("copy"));
    expect(res.status).toBe(404);
    const recheckBody = (await res.json()) as { error: string };
    // The re-check maps to `Brief "<router id>" not found.` — the duplicate's source.
    expect(recheckBody).toEqual({ error: `Brief "${campaignId}" not found.` });
    expect(recheckBody.error).not.toContain(third.slug);
    expect(free).toHaveBeenCalledTimes(1);
    expect([...free.mock.calls[0]![1]].sort()).toEqual(["alt.png"]);

    // Resolve-time-hidden: pre-hidden third → plain CampaignNotFoundError(third) →
    // `Brief "<third>" not found.`. Differs from the re-check body (decision 4).
    await preHide(third.slug);
    const hidden = await duplicate(ONLY_T1, campaignId, unique("hidden-copy"));
    expect(hidden.status).toBe(404);
    expect((await hidden.json()) as { error: string }).toEqual({
      error: `Brief "${third.slug}" not found.`,
    });

    // No new campaign rows, no new files: the rollback freed the source copy and the new
    // free freed the third's copy.
    expect(await counts(harness.db)).toEqual(snapshot);
    // The third's own files are untouched.
    expect(await namesOf(third.slug)).toEqual(["alt.png"]);
  });
});
