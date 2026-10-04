import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
  type CampaignBrief,
} from "@campaignfoundry/CampaignOrchestration";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { setCapabilities } from "../../../lib/capabilities.js";
import { resetObjectStoreClient, setObjectStoreClient } from "../../../lib/object-store/index.js";
import { getAssetStore, resetAssetStore } from "../../../lib/ports/index.js";
import { ObjectAssetStore } from "../../../lib/ports/object-asset-store.js";
import { PgBriefStore } from "../../../lib/ports/pg-brief-store.js";
import type { SqlClient } from "../../../lib/db/sql-client.js";
import type { TenantContext } from "../../../lib/tenant.js";
import assetsPostHandler from "../assets.post.js";
import briefsPostHandler from "../briefs.post.js";
import briefsPutHandler from "../briefs/[id].put.js";
import duplicatePostHandler from "../briefs/[id]/duplicate.post.js";
import indexPostHandler from "../index.post.js";
import {
  mountTenantRoute,
  setupPgHarness,
  type PgHarness,
} from "../../__tests__/tenant-harness.js";

/**
 * The WRITE side under `s3` (PT-4k2b, D208 D, D210 a/b/c, D211 c): `briefs.post` and
 * `briefs/[id].put` resolve every ref a body carries to an asset row the caller can SEE,
 * copy what is not theirs, and store ids rather than paths.
 *
 * ## One 404 per route, and how it is pinned
 *
 * Every refusal below is compared **byte for byte against what the SAME route already
 * answers when the brief's own campaign is hidden** — the same request, same id, sent by
 * `ONLY_T2`, which cannot see the t1 target. That is D210(c)'s whole point: hidden,
 * absent, another org's and malformed must be indistinguishable, or a guessable slug
 * becomes a probe. Asserting the literal string instead would pin a message without
 * pinning that it is the SAME one.
 *
 * ## Zero side effects, measured as a delta
 *
 * A refusal here writes nothing, but these tests share one database and the successful
 * ones leave copies, versions and minted campaigns behind — so "nothing happened" is a
 * before/after difference inside each test, never an absolute count. The `copyAssets`
 * spy is the sharper half: a refusal that copied first would still end with the right
 * answer and a target full of another campaign's assets.
 *
 * ## One database per describe, and a fresh target per test
 *
 * `briefs.post`'s EEXIST gate runs BEFORE the resolve, so a target that any earlier test
 * gave a version answers 409 to every later non-replace post — and PUT is the opposite,
 * since `rewriteBrief` ENOENTs a versionless campaign. Rather than reason about which
 * tests write and share targets, each test that acts on a target mints its own. Refusal
 * tests share one read-only target per route, because a 404 writes no version at all.
 *
 * The row-deletion cases mint their own source too, so nothing here needs the
 * beforeEach `restoreRows` the shared render fixture uses: no row any other test names
 * is ever deleted, and a deleted row is one only this test minted.
 */

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
/**
 * A DIFFERENT byte string. `copyAssets` reuses a name the target already holds by these
 * exact bytes and inserts no row, so a carry test that copied identical bytes would pass
 * without a copy ever having happened.
 */
const PNG_ALT = Buffer.concat([PNG, Buffer.from([0x00])]);

/** Same org, team `t2`: invisible to `ONLY_T1`, and where every hidden ref points. */
const THEIRS = "theirs";
/** Another org, with a real asset there and none in ours. */
const OTHER_ORG_CAMP = "theirs-other";
const OTHER_ORG = "other";

const OWNER: TenantContext = { orgId: "local", userId: "owner", roles: ["owner"], teamIds: [] };
const ONLY_T1: TenantContext = { orgId: "local", userId: "u1", roles: [], teamIds: ["t1"] };
/** The comparison caller: cannot see a t1 campaign, so the route's OWN gate answers. */
const ONLY_T2: TenantContext = { orgId: "local", userId: "u2", roles: [], teamIds: ["t2"] };

/** Not a uuid, so `isAssetId` refuses it and it is read as a path — which names no campaign. */
const MALFORMED_ID = "not-a-uuid";

const pathRef = (slug: string): string => `assets/inputs/${slug}/logo.png`;

type Field =
  | "products[].logoPath"
  | "products[].inputAsset"
  | "audio.path"
  | "copy.timeline.beats[].background";

const FIELDS: readonly Field[] = [
  "products[].logoPath",
  "products[].inputAsset",
  "audio.path",
  "copy.timeline.beats[].background",
];

/**
 * A brief of `id`'s own, whose NEUTRAL ref is `own` — the target's own asset.
 *
 * **Never a root-level demo ref.** Under `s3` `save` a ref naming no campaign is refused
 * BY DESIGN (D208 D), so a neutral like `assets/inputs/hydra-logo.png` would refuse the
 * request from a field the test is not about, and every case below would answer 404 for
 * the wrong reason. The one place a campaign-less ref is the subject is the case that
 * names it as such.
 */
const baseBrief = (id: string, own: string): CampaignBrief => ({
  schemaVersion: BRIEF_SCHEMA_VERSION,
  template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
  id,
  mode: "brief",
  targetRegion: "US",
  targetAudience: "developers",
  campaignMessage: "Build faster",
  products: [{ id: "p1", name: "P1", primaryColor: "#1473E6", logoPath: own }],
});

/** The brief's base plus `ref` in the one field under test. */
const withRef = (field: Field, ref: string, id: string, own: string): CampaignBrief => {
  const base = baseBrief(id, own);
  switch (field) {
    case "products[].logoPath":
      return {
        ...base,
        products: [{ id: "p1", name: "P1", primaryColor: "#1473E6", logoPath: ref }],
      };
    case "products[].inputAsset":
      return {
        ...base,
        products: [
          { id: "p1", name: "P1", primaryColor: "#1473E6", logoPath: own, inputAsset: ref },
        ],
      };
    case "audio.path":
      return {
        ...base,
        audio: { path: ref, rights: { licenceId: "lic-1", source: "library" } },
      };
    case "copy.timeline.beats[].background":
      return {
        ...base,
        // A `copy.timeline` only parses on a motion brief, so the beats field's cases
        // carry the envelope `parseBrief` demands (the render fixture's own note).
        mode: "variation",
        output: { formats: ["motion"] },
        variation: { count: 1 },
        copy: {
          timeline: {
            beats: [{ text: "Go", weight: 2, background: ref }],
            transition: "cut",
            keyBeat: 1,
          },
        },
      };
  }
};

/** EVERY ref of a brief is the target's own path — what a save has to normalise to ids. */
const allOwnPath = (id: string, own: string): CampaignBrief => ({
  ...baseBrief(id, own),
  mode: "variation",
  output: { formats: ["motion"] },
  variation: { count: 1 },
  products: [{ id: "p1", name: "P1", primaryColor: "#1473E6", logoPath: own, inputAsset: own }],
  audio: { path: own, rights: { licenceId: "lic-1", source: "library" } },
  copy: {
    timeline: {
      beats: [{ text: "Go", weight: 2, background: own }],
      transition: "cut",
      keyBeat: 1,
    },
  },
});

/** Every ref of a brief is the foreign `ref` — the carry-item shape. */
const allForeignId = (id: string, ref: string): CampaignBrief => ({
  ...baseBrief(id, ref),
  mode: "variation",
  output: { formats: ["motion"] },
  variation: { count: 1 },
  products: [{ id: "p1", name: "P1", primaryColor: "#1473E6", logoPath: ref, inputAsset: ref }],
  audio: { path: ref, rights: { licenceId: "lic-1", source: "library" } },
  copy: {
    timeline: {
      beats: [{ text: "Go", weight: 2, background: ref }],
      transition: "cut",
      keyBeat: 1,
    },
  },
});

/**
 * The refusal shapes D210(c) folds into one 404, named so a skipped case is visible.
 *
 * `an id whose row is gone` and `a path whose row is gone` are the same deletion seen
 * through each ref form, and the deletion needs a row of its own: they mint one and
 * remove it inside the test, so nothing shared is ever deleted and no `beforeEach` has
 * to put it back.
 */
const REFUSALS = [
  "a team-HIDDEN id",
  "a team-HIDDEN path",
  "another org's id",
  "an id whose row is gone",
  "a path whose row is gone",
  "a MALFORMED id",
] as const;

type Refusal = (typeof REFUSALS)[number];

/** Whatever sits in the one field under test. */
const readRef = (brief: CampaignBrief, field: Field): string => {
  switch (field) {
    case "products[].logoPath":
      return brief.products[0]!.logoPath;
    case "products[].inputAsset":
      return brief.products[0]!.inputAsset!;
    case "audio.path":
      return brief.audio!.path;
    case "copy.timeline.beats[].background":
      return brief.copy!.timeline!.beats[0]!.background!;
  }
};

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

/** What a refusal may not change, as three row counts. */
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

describe("the write routes under s3 — every ref stored as an id the caller can see (PT-4k2b)", () => {
  let harness: PgHarness;
  let ownerStore: PgBriefStore;
  /** Real ids, from `POST /campaigns/assets`. */
  const ids: Record<string, string> = {};
  /** The read-only comparison targets: t1, so `ONLY_T1` sees them and `ONLY_T2` cannot. */
  const CMP_POST = "cmp-post";
  const CMP_PUT = "cmp-put";
  let seq = 0;
  const unique = (prefix: string): string => `${prefix}-${(seq += 1)}`;
  const SAVED_OBJECT_STORE = process.env.OBJECT_STORE;

  /**
   * A campaign of its own, uploaded to, and — for PUT — versioned.
   *
   * Fresh per test rather than shared: `briefs.post`'s EEXIST gate reads `hasVersion`
   * before the resolve, so a shared target turns one test's 201 into every later test's
   * 409, and PUT is the mirror image (`rewriteBrief` ENOENTs a versionless campaign).
   * Sharing them would mean a table of which test writes and which does not; minting
   * costs one campaign and one upload and makes the answer independent of test order.
   */
  const freshTarget = async (versioned: boolean): Promise<{ slug: string; ownId: string }> => {
    const slug = unique("target");
    await ownerStore.createCampaign(slug, { teamId: "t1" });
    const ownId = await upload(OWNER, slug);
    if (versioned) await ownerStore.createBrief(baseBrief(slug, pathRef(slug)), { teamId: "t1" });
    return { slug, ownId };
  };

  /**
   * A visible foreign campaign of its own, with a differently-bitted upload.
   *
   * Its own per test for the two tests that `deleteAssets` it: freeing a shared source
   * would leave the ids every other test asserts on naming a row that is gone.
   */
  const freshSource = async (): Promise<{ slug: string; id: string }> => {
    const slug = unique("source");
    await ownerStore.createCampaign(slug, { teamId: "t1" });
    return { slug, id: await upload(OWNER, slug, "logo.png", PNG_ALT) };
  };

  beforeAll(async () => {
    setCapabilities({ motion: true });
    process.env.OBJECT_STORE = "s3";
    harness = await setupPgHarness();
    setObjectStoreClient(new InMemoryObjectStore());
    resetAssetStore();
    await harness.db.query(
      `insert into team (id, name, "memberCount", org_id, created_at) values
         ($1, $2, 0, $3, now()), ($4, $5, 0, $3, now())`,
      ["t1", "Team One", "local", "t2", "Team Two"],
    );
    await harness.db.query(`insert into org (id, name) values ($1, $1)`, [OTHER_ORG]);
    ownerStore = new PgBriefStore(harness.db, "local", "owner", ["owner"], []);
    await ownerStore.createCampaign(THEIRS, { teamId: "t2" });
    await ownerStore.createCampaign(CMP_POST, { teamId: "t1" });
    await ownerStore.createCampaign(CMP_PUT, { teamId: "t1" });
    await new PgBriefStore(harness.db, OTHER_ORG, "o", [], []).createCampaign(OTHER_ORG_CAMP);
    ids[THEIRS] = await upload(OWNER, THEIRS);
    ids[CMP_POST] = await upload(OWNER, CMP_POST);
    ids[CMP_PUT] = await upload(OWNER, CMP_PUT);
    ids[OTHER_ORG_CAMP] = await upload({ ...OWNER, orgId: OTHER_ORG }, OTHER_ORG_CAMP);
  });

  beforeEach(() => {
    // Nothing to restore: a refusal mints nothing and deletes nothing, and the only rows
    // any test removes are ones it minted itself — see the header.
  });

  afterEach(() => {
    resetAssetStore();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    resetObjectStoreClient();
    resetAssetStore();
    setCapabilities({ motion: false, reason: "not probed" });
    if (SAVED_OBJECT_STORE === undefined) delete process.env.OBJECT_STORE;
    else process.env.OBJECT_STORE = SAVED_OBJECT_STORE;
    await harness.cleanup();
  });

  const store = () => getAssetStore(ONLY_T1);

  /** One refusal shape's ref, minting and removing a row of its own where it needs one. */
  const refusalRef = async (which: Refusal): Promise<string> => {
    switch (which) {
      case "a team-HIDDEN id":
        return ids[THEIRS]!;
      case "a team-HIDDEN path":
        return pathRef(THEIRS);
      case "another org's id":
        return ids[OTHER_ORG_CAMP]!;
      case "an id whose row is gone":
      case "a path whose row is gone": {
        const absent = await freshSource();
        await harness.db.query(`delete from asset where id = $1`, [absent.id]);
        return which === "an id whose row is gone" ? absent.id : pathRef(absent.slug);
      }
      case "a MALFORMED id":
        return MALFORMED_ID;
    }
  };

  /** What a refusal may not change: the three row counts, all of them. */
  const expectNoRows = async (before: Counts): Promise<void> => {
    expect(await counts(harness.db)).toEqual(before);
  };

  /**
   * A campaign delta of zero and a `copyAssets` never called: the shape of a refusal that
   * happens BEFORE any copy. The race tests below are the mirror — their `copyAssets` ran
   * on purpose, so they assert the rows alone.
   */
  const expectRefusal = async (before: Counts, copyAssets: { mock: { calls: unknown[] } }) => {
    await expectNoRows(before);
    expect(copyAssets.mock.calls).toEqual([]);
  };

  /**
   * The 404 this route ALREADY gives for a brief whose own campaign is hidden: the same
   * request, same id, from a caller who cannot see the target. Byte-for-byte equality
   * with the refusal below is the whole of D210(c).
   */
  const postOwnHidden = async (): Promise<unknown> => {
    const res = await post(ONLY_T2, baseBrief(CMP_POST, pathRef(CMP_POST)));
    expect(res.status).toBe(404);
    return res.json();
  };

  const putOwnHidden = async (): Promise<unknown> => {
    const res = await put(ONLY_T2, CMP_PUT, baseBrief(CMP_PUT, pathRef(CMP_PUT)));
    expect(res.status).toBe(404);
    return res.json();
  };

  /**
   * `duplicate.post`'s own hidden-campaign 404 for the very same source: `ONLY_T2` is
   * outside `source`'s team, so this route's own `resolveCampaignRef` gate answers, and
   * the body names the router param — which is what makes it the right comparison for a
   * ref refusal instead of a literal string (D210 c).
   */
  const dupOwnHidden = async (source: string): Promise<unknown> => {
    const res = await duplicate(ONLY_T2, source, unique("copy"));
    expect(res.status).toBe(404);
    return res.json();
  };

  /** `index.post`'s own, for the same source and the same reason. */
  const createOwnHidden = async (source: string): Promise<unknown> => {
    const res = await createFrom(ONLY_T2, { name: unique("copy"), source });
    expect(res.status).toBe(404);
    return res.json();
  };

  describe.each(FIELDS)("briefs.post — the %s field", (field) => {
    test.each(REFUSALS)(
      "%s answers the hidden-campaign body with zero side effects",
      async (which) => {
        const copyAssets = vi.spyOn(ObjectAssetStore.prototype, "copyAssets");
        // The ref FIRST: the row-gone cases mint and remove a row of their own, and that
        // is fixture work the snapshot must already include.
        const ref = await refusalRef(which);
        const before = await postOwnHidden();
        const snapshot = await counts(harness.db);
        copyAssets.mockClear();

        const res = await post(ONLY_T1, withRef(field, ref, CMP_POST, pathRef(CMP_POST)));
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual(before);
        await expectRefusal(snapshot, copyAssets);
      },
    );
  });

  describe.each(FIELDS)("briefs.put — the %s field", (field) => {
    test.each(REFUSALS)(
      "%s answers the hidden-campaign body with zero side effects",
      async (which) => {
        const copyAssets = vi.spyOn(ObjectAssetStore.prototype, "copyAssets");
        const ref = await refusalRef(which);
        const before = await putOwnHidden();
        const snapshot = await counts(harness.db);
        copyAssets.mockClear();

        const res = await put(ONLY_T1, CMP_PUT, withRef(field, ref, CMP_PUT, pathRef(CMP_PUT)));
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual(before);
        await expectRefusal(snapshot, copyAssets);
      },
    );
  });

  /**
   * The two copy routes, once they are wired to the helper (PT-4k2b2).
   *
   * They refuse through the SAME body they give for a source they cannot see, which is
   * the D210(c) change and the reason the literal `Brief "<slug>" not found.` these two
   * used to answer — naming the slug read OUT of the ref, the oracle a guessable slug
   * turns into a probe — is gone from `s3`. Every case below is compared against the
   * route's own hidden-source 404 rather than against a string, so the assertion is that
   * the two are indistinguishable, not that a message reads well.
   *
   * A source brief is seeded with `createBrief` as OWNER, never through the route: the
   * refs under test are exactly the ones the route now refuses to store, so the fixture
   * has to be able to write them directly. It must also carry a resolvable neutral ref —
   * a brief whose OTHER fields name the source's own asset row — or the resolve would
   * refuse from a field the case is not about (the header's own rule, inverted).
   */
  const seedSourceBrief = async (
    field: Field,
    ref: string | ((slug: string) => string),
    prefix: string,
  ): Promise<{ slug: string; campaignId: string }> => {
    const slug = unique(prefix);
    const { campaignId } = await ownerStore.createCampaign(slug, { teamId: "t1" });
    await upload(OWNER, slug, "logo.png");
    await ownerStore.createBrief(
      withRef(field, typeof ref === "function" ? ref(slug) : ref, slug, pathRef(slug)),
      { teamId: "t1" },
    );
    return { slug, campaignId };
  };

  describe.each(FIELDS)("duplicate.post — the %s field", (field) => {
    test.each(REFUSALS)(
      "%s answers the hidden-campaign body with zero side effects",
      async (which) => {
        const copyAssets = vi.spyOn(ObjectAssetStore.prototype, "copyAssets");
        const ref = await refusalRef(which);
        const source = (await seedSourceBrief(field, ref, "src-dup")).campaignId;
        // **The source is addressed by its uuid, not its slug, and that is the whole
        // reason this comparison can fail.** The refusal's own body names `template.id`,
        // which is the source's SLUG, so with a slug-addressed request the ref-named body
        // and the hidden-source body are the same string whether or not this route maps
        // the refusal — and the oracle would be unpinned. Addressing by uuid is also what
        // the web does, and it is where the two bodies genuinely differ.
        const before = await dupOwnHidden(source);
        const snapshot = await counts(harness.db);
        copyAssets.mockClear();

        const res = await duplicate(ONLY_T1, source, unique("copy"));
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual(before);
        await expectRefusal(snapshot, copyAssets);
      },
    );
  });

  describe.each(FIELDS)("index.post — the %s field", (field) => {
    test.each(REFUSALS)(
      "%s answers the hidden-campaign body with zero side effects",
      async (which) => {
        const copyAssets = vi.spyOn(ObjectAssetStore.prototype, "copyAssets");
        const ref = await refusalRef(which);
        const source = (await seedSourceBrief(field, ref, "src-create")).campaignId;
        const before = await createOwnHidden(source);
        const snapshot = await counts(harness.db);
        copyAssets.mockClear();

        const res = await createFrom(ONLY_T1, { name: unique("copy"), source });
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual(before);
        await expectRefusal(snapshot, copyAssets);
      },
    );
  });

  test("briefs.post stores a path ref to the target's OWN asset as its id, and copies nothing", async () => {
    // The resolve alone answers this: the row is already the target's, so there is no
    // copy source at all — and saving the body's own path would store a path under s3
    // (D208 D), which is what a caller must never be able to read back as an id.
    const copyAssets = vi.spyOn(ObjectAssetStore.prototype, "copyAssets");
    const { slug, ownId } = await freshTarget(false);
    const res = await post(ONLY_T1, allOwnPath(slug, pathRef(slug)));
    expect(res.status).toBe(201);
    const stored = (await res.json()).brief as CampaignBrief;
    expect(storedRefs(stored)).toEqual([ownId]);
    expect(copyAssets).not.toHaveBeenCalled();
  });

  test("briefs.put stores a path ref to the target's OWN asset as its id, and copies nothing", async () => {
    const copyAssets = vi.spyOn(ObjectAssetStore.prototype, "copyAssets");
    const { slug, ownId } = await freshTarget(true);
    const res = await put(ONLY_T1, slug, allOwnPath(slug, pathRef(slug)));
    expect(res.status).toBe(200);
    const stored = (await res.json()).brief as CampaignBrief;
    expect(storedRefs(stored)).toEqual([ownId]);
    expect(copyAssets).not.toHaveBeenCalled();
  });

  test("CARRY ITEM 1: a Save-as whose four fields carry another campaign's ids copies it in and still reads", async () => {
    // The gap this lane closes: no path in the body, so the path-derived copy-source list
    // saw nothing, the new brief SHARED X's ids, and deleting X later ENOENTed it.
    const source = await freshSource();
    const { slug } = await freshTarget(false);
    const res = await post(ONLY_T1, allForeignId(slug, source.id));
    expect(res.status).toBe(201);
    const stored = (await res.json()).brief as CampaignBrief;
    const refs = storedRefs(stored);
    expect(refs).toHaveLength(1);
    expect(refs[0]).not.toBe(source.id);
    for (const ref of refs) {
      expect((await store().assetOwner(ref))?.slug).toBe(slug);
    }
    // ...and now the source campaign is gone, which is the whole point of copying.
    await store().deleteAssets(source.slug);
    expect((await store().readAssetById(refs[0]!))?.equals(PNG_ALT)).toBe(true);
  });

  test("briefs.put with a visible foreign id stores a TARGET-owned id that outlives its source", async () => {
    // D210(b): PUT is the web's main save path, and a ref left here is one the editor
    // keeps sending — so it is copied and remapped, never left shared.
    const source = await freshSource();
    const { slug } = await freshTarget(true);
    const res = await put(ONLY_T1, slug, allForeignId(slug, source.id));
    expect(res.status).toBe(200);
    const stored = (await res.json()).brief as CampaignBrief;
    const refs = storedRefs(stored);
    expect(refs).toHaveLength(1);
    expect(refs[0]).not.toBe(source.id);
    expect((await store().assetOwner(refs[0]!))?.slug).toBe(slug);
    await store().deleteAssets(source.slug);
    expect((await store().readAssetById(refs[0]!))?.equals(PNG_ALT)).toBe(true);
  });

  test("briefs.post with a stale revision answers 409 and copies nothing", async () => {
    const copyAssets = vi.spyOn(ObjectAssetStore.prototype, "copyAssets");
    const source = await freshSource();
    const { slug } = await freshTarget(true);
    const res = await post(
      ONLY_T1,
      allForeignId(slug, source.id),
      "?replace=1&revision=not-the-current-revision",
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Brief was modified by another user.");
    // The guard sits BETWEEN the resolve and the copy: a request that will 409 must not
    // leave the source campaign's assets copied into the target first.
    expect(copyAssets).not.toHaveBeenCalled();
  });

  test("briefs.put with a stale revision answers 409 and copies nothing", async () => {
    const copyAssets = vi.spyOn(ObjectAssetStore.prototype, "copyAssets");
    const source = await freshSource();
    const { slug } = await freshTarget(true);
    const res = await put(
      ONLY_T1,
      slug,
      allForeignId(slug, source.id),
      "?revision=not-the-current-revision",
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; revision: string };
    expect(body.error).toBe("Brief was modified by another user.");
    expect(body.revision).toBeTruthy();
    expect(copyAssets).not.toHaveBeenCalled();
  });

  test("briefs.put refuses a VERSIONLESS target before copying anything", async () => {
    // D211(c): `rewriteBrief` ENOENTs a versionless campaign anyway, so this only moves
    // the same refusal ahead of the copy — and answers it without a copy.
    const copyAssets = vi.spyOn(ObjectAssetStore.prototype, "copyAssets");
    const source = await freshSource();
    const { slug } = await freshTarget(false);
    const res = await put(ONLY_T1, slug, allForeignId(slug, source.id));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: `Brief "${slug}" not found.` });
    expect(copyAssets).not.toHaveBeenCalled();
  });

  test("RACE: a copy that maps nothing is refused, and no version is written", async () => {
    // `copyAssets` copies the rows that exist WHEN it runs. An asset deleted between the
    // resolve and the copy is missing from the map, its id survives the rewrite, and no
    // other check can see it — the brief would be written still naming another
    // campaign's absent asset.
    const source = await freshSource();
    const { slug } = await freshTarget(false);
    const real = ObjectAssetStore.prototype.copyAssets;
    const copyAssets = vi
      .spyOn(ObjectAssetStore.prototype, "copyAssets")
      .mockImplementation(async function (this: ObjectAssetStore, from: string, to: string) {
        return from === source.slug ? {} : await real.call(this, from, to);
      });
    const snapshot = await counts(harness.db);

    const res = await post(ONLY_T1, allForeignId(slug, source.id));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: `Campaign "${slug}" not found` });
    expect(copyAssets).toHaveBeenCalled();
    expect(Number((await counts(harness.db)).versions)).toBe(snapshot.versions);
  });

  test("RACE on PUT: a copy that maps nothing is refused, and no version is written", async () => {
    const source = await freshSource();
    const { slug } = await freshTarget(true);
    const real = ObjectAssetStore.prototype.copyAssets;
    const copyAssets = vi
      .spyOn(ObjectAssetStore.prototype, "copyAssets")
      .mockImplementation(async function (this: ObjectAssetStore, from: string, to: string) {
        return from === source.slug ? {} : await real.call(this, from, to);
      });
    const snapshot = await counts(harness.db);

    const res = await put(ONLY_T1, slug, allForeignId(slug, source.id));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: `Brief "${slug}" not found.` });
    expect(copyAssets).toHaveBeenCalled();
    expect(Number((await counts(harness.db)).versions)).toBe(snapshot.versions);
  });

  /**
   * The source's OWN path ref is normalised to an id and stored under the COPY's campaign.
   *
   * **No `copyAssets`-free case exists on a copy route**, and that is not an omission: a
   * path ref naming the SOURCE names a campaign the route is about to copy wholesale, so
   * `copyAssets(source, target)` always runs and is exactly what turns that id into the
   * target's. The D208(D) half is what this asserts — the stored ref is an id, not the
   * path the source carried — and `copyAssets` is asserted to have been called with the
   * source, so the id cannot have come from anywhere else.
   */
  test("duplicate stores the source's own PATH ref as the copy's own asset id", async () => {
    const copyAssets = vi.spyOn(ObjectAssetStore.prototype, "copyAssets");
    const source = (await seedSourceBrief("products[].logoPath", pathRef, "src-own-path")).slug;
    const res = await duplicate(ONLY_T1, source, unique("copy"));
    expect(res.status).toBe(201);
    const stored = (await res.json()).brief as CampaignBrief;
    const ref = readRef(stored, "products[].logoPath");
    expect(ref).not.toContain("/");
    expect((await store().assetOwner(ref))?.slug).toBe(stored.id);
    expect(copyAssets).toHaveBeenCalledWith(source, stored.id);
  });

  test("a sourced create stores the source's own PATH ref as the copy's own asset id", async () => {
    const copyAssets = vi.spyOn(ObjectAssetStore.prototype, "copyAssets");
    const source = (await seedSourceBrief("products[].logoPath", pathRef, "src-own-path-c")).slug;
    const res = await createFrom(ONLY_T1, { name: unique("copy"), source });
    expect(res.status).toBe(201);
    const { slug } = (await res.json()) as { slug: string };
    const stored = (await ownerStore.findBriefById(slug))!.brief;
    const ref = readRef(stored, "products[].logoPath");
    expect(ref).not.toContain("/");
    expect((await store().assetOwner(ref))?.slug).toBe(slug);
    expect(copyAssets).toHaveBeenCalledWith(source, slug);
  });

  test("CARRY ITEM 2: duplicate brings a THIRD campaign's asset id over, and the copy outlives it", async () => {
    // The gap this lane closes on these two routes: the copy-source list was
    // `extractSourceAssetBriefIds`, which matches PATHS only. A source brief naming a
    // third campaign's asset by ID therefore named no copy source at all, so the copy
    // went on to SHARE that id — and deleting the third campaign left the copy's logo
    // pointing at an asset in no campaign at all.
    const third = await freshSource();
    const source = (await seedSourceBrief("products[].logoPath", third.id, "src-third-dup")).slug;
    const res = await duplicate(ONLY_T1, source, unique("copy"));
    expect(res.status).toBe(201);
    const stored = (await res.json()).brief as CampaignBrief;
    const refs = storedRefs(stored);
    expect(refs).toHaveLength(1);
    expect(refs[0]).not.toBe(third.id);
    expect((await store().assetOwner(refs[0]!))?.slug).toBe(stored.id);
    // ...and now the third campaign is gone, which is the whole point of copying.
    await store().deleteAssets(third.slug);
    expect((await store().readAssetById(refs[0]!))?.equals(PNG_ALT)).toBe(true);
  });

  test("CARRY ITEM 2 on index.post: a sourced create brings a THIRD campaign's id over", async () => {
    const third = await freshSource();
    const source = (await seedSourceBrief("products[].logoPath", third.id, "src-third-create"))
      .slug;
    const res = await createFrom(ONLY_T1, { name: unique("copy"), source });
    expect(res.status).toBe(201);
    const { slug } = (await res.json()) as { slug: string };
    const stored = (await ownerStore.findBriefById(slug))!.brief;
    const refs = storedRefs(stored);
    expect(refs).toHaveLength(1);
    expect(refs[0]).not.toBe(third.id);
    expect((await store().assetOwner(refs[0]!))?.slug).toBe(slug);
    await store().deleteAssets(third.slug);
    expect((await store().readAssetById(refs[0]!))?.equals(PNG_ALT)).toBe(true);
  });

  test("RACE on duplicate: a copy that maps nothing releases the minted campaign and frees its assets", async () => {
    // The source's OWN copy is left real, so the target really does hold copied rows when
    // the third campaign's copy answers `{}` — which is what makes the freed-asset half
    // of the delta an assertion rather than a count of zero that was always zero.
    const third = await freshSource();
    const source = (await seedSourceBrief("products[].logoPath", third.id, "src-race-dup")).slug;
    const real = ObjectAssetStore.prototype.copyAssets;
    const copyAssets = vi
      .spyOn(ObjectAssetStore.prototype, "copyAssets")
      .mockImplementation(async function (this: ObjectAssetStore, from: string, to: string) {
        return from === third.slug ? {} : await real.call(this, from, to);
      });
    const snapshot = await counts(harness.db);

    const res = await duplicate(ONLY_T1, source, unique("copy"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: `Brief "${source}" not found.` });
    expect(copyAssets).toHaveBeenCalled();
    // Every one of the three counts: the copied rows were freed, no version was written,
    // and the reservation was released.
    await expectNoRows(snapshot);
  });

  test("RACE on index.post: a copy that maps nothing releases the minted campaign and frees its assets", async () => {
    const third = await freshSource();
    const source = (await seedSourceBrief("products[].logoPath", third.id, "src-race-create")).slug;
    const real = ObjectAssetStore.prototype.copyAssets;
    const copyAssets = vi
      .spyOn(ObjectAssetStore.prototype, "copyAssets")
      .mockImplementation(async function (this: ObjectAssetStore, from: string, to: string) {
        return from === third.slug ? {} : await real.call(this, from, to);
      });
    const snapshot = await counts(harness.db);

    const res = await createFrom(ONLY_T1, { name: unique("copy"), source });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: `Brief "${source}" not found.` });
    expect(copyAssets).toHaveBeenCalled();
    await expectNoRows(snapshot);
  });
});

describe("briefs.put on pg + fs is untouched by the write-side checks (PT-4k2b, D208 D)", () => {
  let harness: PgHarness;
  const SAVED_OBJECT_STORE = process.env.OBJECT_STORE;

  beforeAll(async () => {
    // Staging today: `STORE_BACKEND=postgres` with `OBJECT_STORE` unset. The route must
    // not call the helper here at all — the non-s3 `save` branch would add a visibility
    // check PUT has never made.
    delete process.env.OBJECT_STORE;
    harness = await setupPgHarness();
    resetAssetStore();
    await harness.db.query(
      `insert into team (id, name, "memberCount", org_id, created_at) values
         ($1, $2, 0, $3, now()), ($4, $5, 0, $3, now())`,
      ["t1", "Team One", "local", "t2", "Team Two"],
    );
    await harness.db.query(`insert into org (id, name) values ($1, $1)`, [OTHER_ORG]);
    const ownerStore = new PgBriefStore(harness.db, "local", "owner", ["owner"], []);
    await ownerStore.createCampaign("open", { teamId: "t1" });
    await ownerStore.createCampaign(THEIRS, { teamId: "t2" });
    await ownerStore.createBrief(baseBrief("open", pathRef(THEIRS)), { teamId: "t1" });
  });

  afterEach(() => {
    resetAssetStore();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    resetAssetStore();
    if (SAVED_OBJECT_STORE === undefined) delete process.env.OBJECT_STORE;
    else process.env.OBJECT_STORE = SAVED_OBJECT_STORE;
    await harness.cleanup();
  });

  test("a PUT carrying a path ref to the team-HIDDEN campaign answers 200, with NO visibility call", async () => {
    const visibility = vi.spyOn(PgBriefStore.prototype, "campaignVisibility");
    // Exactly what this route has always done with this body: off s3 a path ref is not
    // checked, so a team-B campaign's path is written into team A's brief untouched.
    // D210(d)/D208(D) leave that answer alone, and the spy is what proves the route did
    // not acquire a check on the way — `campaignVisibility` has no internal caller in
    // `PgBriefStore`, so 0 calls means the route never asked.
    const res = await put(ONLY_T1, "open", baseBrief("open", pathRef(THEIRS)));
    expect(res.status).toBe(200);
    const stored = (await res.json()).brief as CampaignBrief;
    expect(stored.products[0]!.logoPath).toBe(pathRef(THEIRS));
    expect(visibility).not.toHaveBeenCalled();
  });
});
