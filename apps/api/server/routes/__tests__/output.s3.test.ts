import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  ObjectPackageStore,
  platformProfile,
  type PackageManifest,
  type PackageManifestItem,
} from "@campaignfoundry/Distribution";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { packagePrefix, renderPrefix } from "../../lib/object-store/object-keys.js";
import { resetObjectStoreClient, setObjectStoreClient } from "../../lib/object-store/index.js";
import type { SqlClient } from "../../lib/db/sql-client.js";
import { getBriefStore } from "../../lib/ports/index.js";
import { ObjectOutputStore } from "../../lib/ports/object-output-store.js";
import outputHandler from "../output/[...path].get.js";
import type { TenantContext } from "../../lib/tenant.js";
import {
  mountTenantRoute,
  resetAllStores,
  setupPgHarness,
  type PgHarness,
} from "./tenant-harness.js";

/**
 * `GET /output/**` under `OBJECT_STORE=s3` (PT-4i, D204).
 *
 * **The route does not exist under `s3`, and that is the whole claim.** Every
 * shape below — a render path, a package path, a traversal, an absolute path, a
 * hidden campaign, another org's slug, a uuid — answers the SAME 404 with the
 * SAME body and the same empty header set, and none of them asks the database, the
 * output store or the bucket anything. So the bytes are seeded where the route
 * would have read them: the render really is in the bucket, the package really is
 * committed, the campaign really is in `local`, and the file really is on disk
 * under the fs output root for the control test at the bottom. A 404 that could
 * also be produced by an empty database would prove nothing, and the visible
 * server's own `routes.test.ts` proves the opposite half — that the very same
 * handler streams those files with 200 when the mode is `fs`.
 *
 * **A NEW file rather than additions to `routes.test.ts`**: that one mocks
 * `node:fs/promises` file-wide and never sets `OBJECT_STORE`, so the mode under
 * test could not be established in it. Static handler import, as
 * `packages.s3.test.ts` explains — the harness installs one database and one
 * object store for the whole file and a re-importing helper would rebuild both.
 */

const LOCAL: TenantContext = { orgId: "local", userId: "u", roles: ["owner"], teamIds: [] };
const GLOBEX: TenantContext = { orgId: "globex", userId: "u", roles: ["owner"], teamIds: [] };
/** Team A's member: the campaign seeded to `t1` is VISIBLE to this caller. */
const TEAM_A: TenantContext = { orgId: "local", userId: "u1", roles: [], teamIds: ["t1"] };
/** Team B's member: the same campaign is HIDDEN from this caller (D166). */
const TEAM_B: TenantContext = { orgId: "local", userId: "u2", roles: [], teamIds: ["tB"] };

const SLUG = "winter-sale";
const CAMPAIGN = "3f1b7a52-0c4d-4a6e-9b21-5d8e7c6a5b4c";
const GLOBEX_CAMPAIGN = "00000000-0000-4000-8000-000000000001";
const PLATFORM = "instagram-feed";
const AT = 1_758_000_000_000;

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const manifestItem = (platformId: string, rest: string): PackageManifestItem => ({
  productId: "alpha",
  aspectRatio: "1x1",
  treatment: "classic",
  format: "static",
  source: `${SLUG}/alpha/1x1.png`,
  packagedPath: `packages/${SLUG}/${platformId}/${SLUG}/${rest}`,
  bytes: PNG.length,
  checks: { size: "pass" },
});

const manifestFor = (
  platformId: string,
  items: readonly PackageManifestItem[],
): PackageManifest => ({
  campaignId: SLUG,
  platformId,
  packagedAt: "2026-08-25T12:00:00.000Z",
  skipped: 0,
  included: items.length,
  excluded: 0,
  profile: platformProfile(platformId)!,
  items: [...items],
});

/**
 * The headers the route must NOT set on a retired answer: the whole range ladder
 * (`accept-ranges`, `content-range`) and the fs path's own `cache-control`.
 * `content-type` is deliberately not in this list — h3 gives an object return
 * `application/json`, which is the same header the fs 404 carries, and what has
 * to be absent is a content type THIS route chose.
 */
const UNSET_HEADERS = ["accept-ranges", "content-range", "cache-control"];

describe("GET /output/** is retired under OBJECT_STORE=s3 (PT-4i, D204)", () => {
  let harness: PgHarness;
  let store: InMemoryObjectStore;
  const SAVED = process.env.OBJECT_STORE;

  const seedCampaign = async (
    db: SqlClient,
    orgId: string,
    slug: string,
    id: string,
    teamId?: string,
  ) => {
    await db.query(`insert into org (id, name) values ($1, $2) on conflict do nothing`, [
      orgId,
      orgId,
    ]);
    await db.query(`insert into campaign (id, org_id, slug, team_id) values ($1, $2, $3, $4)`, [
      id,
      orgId,
      slug,
      teamId ?? null,
    ]);
  };

  /** The render the report names, in the bucket, where a lookup would find it. */
  const seedRender = async (orgId: string, uuid: string) => {
    await store.put(`${renderPrefix(orgId, uuid)}alpha/1x1.png`, PNG, {
      contentType: "image/png",
    });
  };

  /** A COMMITTED package: the packaged copies, then the manifest that makes it live. */
  const commitPackage = async (uuid: string, orgId: string) => {
    const writer = new ObjectPackageStore(store, {
      renderPrefix: renderPrefix(orgId, uuid),
      packagePrefix: packagePrefix(orgId, uuid),
      campaignSegment: SLUG,
      now: () => AT,
      nonce: () => "a".repeat(32),
    });
    await writer.writePackaged(PLATFORM, `${SLUG}/alpha/1x1.png`, PNG);
    await writer.writeManifest(
      PLATFORM,
      manifestFor(PLATFORM, [manifestItem(PLATFORM, "alpha/1x1.png")]),
    );
  };

  const outputCall = (
    path: string,
    tenant: TenantContext = LOCAL,
    headers: Record<string, string> = {},
  ) =>
    mountTenantRoute(outputHandler, { path: "/output/**:path", tenant })(
      new Request(`http://x/output/${path}`, { headers }),
    );

  /**
   * The raw-param caller `team-gates-on-routes.test.ts:289-296` and
   * `routes.test.ts` use: a real HTTP request never carries `..`, so the guard
   * this lane moves above the traversal check can only be driven through a router
   * param set by hand.
   */
  const rawCall = (pathParam: string, tenant: TenantContext = LOCAL) => {
    const handler = (event: Parameters<typeof outputHandler>[0]) => {
      event.context.params = { path: pathParam };
      return outputHandler(event);
    };
    return mountTenantRoute(handler, { path: "/output/**:path", tenant })(
      new Request("http://x/output/placeholder"),
    );
  };

  /**
   * A spy as this file uses one: counted by `toHaveBeenCalled`, and cleared when a
   * test's own SEEDING has to be taken out of the count. Only those two members are
   * named, so the list below stays a plain array of pairs rather than a type
   * imported out of the test framework's internals.
   */
  interface Tracked {
    readonly label: string;
    readonly spy: { readonly mockClear: () => void };
  }
  const track = (label: string, spy: { mockClear: () => void }): Tracked => ({ label, spy });

  /**
   * Every spy that stands for a side effect this deployment must not have: the two
   * brief-store calls the resolution and the visibility loop make, the output
   * store's own `openOutput`, and the two object-store operations anything could
   * read or list with.
   */
  let sideEffects: Tracked[];

  /** Every answer is this one answer, and none of them cost a round trip. */
  const expectRetired = async (res: Response, alreadyRead?: string) => {
    expect(res.status).toBe(404);
    // Read ONCE: a body can only be read once, so a caller that compared two
    // answers textually hands its own read in rather than paying for a second.
    expect(alreadyRead === undefined ? await res.json() : JSON.parse(alreadyRead)).toEqual({
      error: "Not found",
    });
    for (const { label, spy } of sideEffects) {
      expect(spy, label).not.toHaveBeenCalled();
    }
    for (const header of UNSET_HEADERS) {
      expect(res.headers.get(header), header).toBeNull();
    }
    expect(res.headers.get("content-type")).toBe("application/json");
  };

  /** Every spy above, back to zero: the SEEDING below is the test's own traffic. */
  const clearSideEffects = () => {
    for (const { spy } of sideEffects) spy.mockClear();
  };

  beforeEach(async () => {
    process.env.OBJECT_STORE = "s3";
    harness = await setupPgHarness();
    store = new InMemoryObjectStore();
    // BEFORE anything can build a client: the slot calls `objectStoreClient()`,
    // which would otherwise reach for `S3_*` settings this file never sets.
    setObjectStoreClient(store);
    resetAllStores();
    await harness.db.query(
      `insert into team (id, name, "memberCount", org_id, created_at) values
         ($1, $2, 0, $3, now()), ($4, $5, 0, $3, now())`,
      ["t1", "Team One", "local", "tB", "Team B"],
    );
    // The registry hands back ONE instance per scope (`ports/index.ts:102-110`),
    // and these callers are four different scopes, so all four are spied: a guard
    // that leaked through on the team caller's store would be caught even though
    // its owner-tenant sibling was not.
    sideEffects = [
      track("LOCAL.resolveCampaign", vi.spyOn(getBriefStore(LOCAL), "resolveCampaign")),
      track("LOCAL.campaignVisibility", vi.spyOn(getBriefStore(LOCAL), "campaignVisibility")),
      track("TEAM_A.resolveCampaign", vi.spyOn(getBriefStore(TEAM_A), "resolveCampaign")),
      track("TEAM_A.campaignVisibility", vi.spyOn(getBriefStore(TEAM_A), "campaignVisibility")),
      track("TEAM_B.resolveCampaign", vi.spyOn(getBriefStore(TEAM_B), "resolveCampaign")),
      track("TEAM_B.campaignVisibility", vi.spyOn(getBriefStore(TEAM_B), "campaignVisibility")),
      track("GLOBEX.resolveCampaign", vi.spyOn(getBriefStore(GLOBEX), "resolveCampaign")),
      track("GLOBEX.campaignVisibility", vi.spyOn(getBriefStore(GLOBEX), "campaignVisibility")),
      track("ObjectOutputStore.openOutput", vi.spyOn(ObjectOutputStore.prototype, "openOutput")),
      track("store.get", vi.spyOn(store, "get")),
      track("store.list", vi.spyOn(store, "list")),
    ];
  });

  afterEach(async () => {
    resetAllStores();
    resetObjectStoreClient();
    vi.restoreAllMocks();
    if (SAVED === undefined) delete process.env.OBJECT_STORE;
    else process.env.OBJECT_STORE = SAVED;
    await harness.cleanup();
  });

  test("a valid render path by slug is 404, with the render in the bucket and nothing read", async () => {
    await seedCampaign(harness.db, "local", SLUG, CAMPAIGN);
    await seedRender("local", CAMPAIGN);

    await expectRetired(await outputCall(`${SLUG}/alpha/1x1.png`));
  });

  test("a package path is 404 with the package committed, and lists nothing", async () => {
    await seedCampaign(harness.db, "local", SLUG, CAMPAIGN);
    await seedRender("local", CAMPAIGN);
    await commitPackage(CAMPAIGN, "local");
    // The package is live and would be found by anyone who asked the store.
    expect(await store.list(`${packagePrefix("local", CAMPAIGN)}${PLATFORM}/`)).not.toHaveLength(0);
    // The writes and that listing are THIS TEST's traffic, not the route's.
    clearSideEffects();

    await expectRetired(await outputCall(`packages/${SLUG}/${PLATFORM}/manifest.json`));
  });

  test("a traversal raw param is 404, not the 400 the fs traversal guard gives", async () => {
    await seedCampaign(harness.db, "local", SLUG, CAMPAIGN);
    await seedRender("local", CAMPAIGN);

    // Both shapes the traversal check rejects on fs: a bare `../..` and a campaign
    // segment followed by one. Under s3 they cannot tell themselves apart from a
    // render path, which is the point — a 400 here would tell a prober that this
    // path was examined at all.
    for (const raw of ["../../etc/passwd", `${SLUG}/../../etc/passwd`]) {
      await expectRetired(await rawCall(raw));
    }
  });

  test("an absolute raw param is 404, not 400", async () => {
    await seedCampaign(harness.db, "local", SLUG, CAMPAIGN);

    await expectRetired(await rawCall("/etc/passwd"));
  });

  test("a hidden campaign's path answers exactly what the visible caller's does", async () => {
    await seedCampaign(harness.db, "local", SLUG, CAMPAIGN, "t1");
    await seedRender("local", CAMPAIGN);

    // The same URL, asked by a member of the campaign's own team and by a member
    // of another one. On fs these two are 200 and 404 — the visibility check is
    // what tells a hidden campaign from a visible one — and the answer here must
    // be byte-identical, headers included, or the route is still leaking.
    const visible = await outputCall(`${SLUG}/alpha/1x1.png`, TEAM_A);
    const hidden = await outputCall(`${SLUG}/alpha/1x1.png`, TEAM_B);
    const visibleText = await visible.text();
    const hiddenText = await hidden.text();
    expect(hiddenText).toBe(visibleText);
    expect(visible.status).toBe(hidden.status);
    for (const header of UNSET_HEADERS) {
      expect(hidden.headers.get(header), header).toBe(visible.headers.get(header));
    }
    expect(hidden.headers.get("content-type")).toBe(visible.headers.get("content-type"));
    await expectRetired(hidden, hiddenText);
  });

  test("another org's path is 404 and resolves nothing of this org's", async () => {
    // GLOBEX holds the slug; LOCAL holds no campaign at all. On fs this is the
    // route's 404 from the store, which under s3 must be the same 404 as every
    // other shape and must cost neither org a row lookup.
    await seedCampaign(harness.db, "globex", SLUG, GLOBEX_CAMPAIGN);
    await seedRender("globex", GLOBEX_CAMPAIGN);

    await expectRetired(await outputCall(`${SLUG}/alpha/1x1.png`, LOCAL));
  });

  test("a uuid-addressed path is 404 and resolves no campaign id", async () => {
    await seedCampaign(harness.db, "local", SLUG, CAMPAIGN);
    await seedRender("local", CAMPAIGN);

    // A uuid is the id `resolveCampaign` tries FIRST, so this is the path that
    // most certainly ran a query before PT-4i.
    await expectRetired(await outputCall(`${CAMPAIGN}/alpha/1x1.png`));
  });

  test("a range request on a real render path is 404, not 206 and not 416", async () => {
    await seedCampaign(harness.db, "local", SLUG, CAMPAIGN);
    await seedRender("local", CAMPAIGN);

    await expectRetired(await outputCall(`${SLUG}/alpha/1x1.png`, LOCAL, { range: "bytes=0-3" }));
  });

  test("postgres + OBJECT_STORE=fs streams the same file by slug and by uuid", async () => {
    // The control: the guard is on the MODE, so the backend that still has an
    // output root keeps the whole ladder. `OBJECT_STORE=fs` plus `resetAllStores()`
    // is what rebuilds the outputs slot as an `FsOutputStore` — without the reset
    // the cached `ObjectOutputStore` would answer this and the control would be
    // testing the mutation instead of the route.
    await seedCampaign(harness.db, "local", SLUG, CAMPAIGN);
    const dir = join(harness.outputRoot, SLUG, "alpha");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "1x1.png"), PNG);
    process.env.OBJECT_STORE = "fs";
    resetAllStores();

    const bySlug = await outputCall(`${SLUG}/alpha/1x1.png`);
    expect(bySlug.status).toBe(200);
    expect(bySlug.headers.get("content-type")).toBe("image/png");
    expect(bySlug.headers.get("accept-ranges")).toBe("bytes");
    expect(new Uint8Array(await bySlug.arrayBuffer())).toEqual(PNG);

    // By uuid: `supportsTeams` is true under postgres, so the id resolves to the
    // slug and the file is found through the resolved path.
    const byUuid = await outputCall(`${CAMPAIGN}/alpha/1x1.png`);
    expect(byUuid.status).toBe(200);
    expect(new Uint8Array(await byUuid.arrayBuffer())).toEqual(PNG);

    // And the traversal guard below the s3 one is still the fs contract: 400.
    expect((await rawCall(`${SLUG}/../../etc/passwd`)).status).toBe(400);
  });
});
