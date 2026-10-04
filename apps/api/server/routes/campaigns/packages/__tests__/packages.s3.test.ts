import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  FileSystemPackageStore,
  latestCommittedGeneration,
  ObjectPackageStore,
  packageGenerationPrefix,
  platformProfile,
  type PackageManifest,
  type PackageManifestItem,
} from "@campaignfoundry/Distribution";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { packagePrefix, renderPrefix } from "../../../../lib/object-store/object-keys.js";
import {
  resetObjectStoreClient,
  setObjectStoreClient,
} from "../../../../lib/object-store/index.js";
import type { SqlClient } from "../../../../lib/db/sql-client.js";
import type { TenantContext } from "../../../../lib/tenant.js";
import outputHandler from "../../../output/[...path].get.js";
import listHandler from "../[campaignId].get.js";
import zipHandler from "../[campaignId]/[platformZip].get.js";
import { parseCentralDirectory } from "./central-directory.js";
import {
  mountTenantRoute,
  resetAllStores,
  setupPgHarness,
  type PgHarness,
} from "../../../__tests__/tenant-harness.js";

/**
 * The two `packages/` routes under `OBJECT_STORE=s3` (PT-4h2, D203, D204, D209f)
 * — the READ side, on the pg harness, with an in-memory bucket.
 *
 * **A NEW file rather than additions to `packages.test.ts`**: that one mocks
 * `node:fs/promises` file-wide, which is exactly the backend this lane stops
 * using, and a file-wide mock would make the s3 assertions lie about everything
 * they do not touch. Static handler imports, as `assets.postgres.test.ts`
 * explains — the harness installs one database and one object store for the whole
 * test and a re-importing helper would rebuild both.
 *
 * **The routes themselves are unchanged by this lane**, which is the point these
 * tests exist to pin: the listing and the zip are the same code as under `fs`,
 * and everything asserted here is what the `ObjectOutputStore` behind the slot
 * has to answer for those two routes to behave identically.
 */

const LOCAL: TenantContext = { orgId: "local", userId: "u", roles: ["owner"], teamIds: [] };
const OTHER: TenantContext = { orgId: "globex", userId: "u", roles: ["owner"], teamIds: [] };
const SLUG = "winter-sale";
const CAMPAIGN = "3f1b7a52-0c4d-4a6e-9b21-5d8e7c6a5b4c";
const OTHER_CAMPAIGN = "00000000-0000-4000-8000-000000000001";
const PLATFORM = "instagram-feed";
const EARLY = 1_758_000_000_000;
const LATE = EARLY + 5_000;

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

describe("the packages routes under OBJECT_STORE=s3 (PT-4h2)", () => {
  let harness: PgHarness;
  let store: InMemoryObjectStore;
  const SAVED = process.env.OBJECT_STORE;

  const seedCampaign = async (db: SqlClient, orgId: string, slug: string, id: string) => {
    await db.query(`insert into org (id, name) values ($1, $2) on conflict do nothing`, [
      orgId,
      orgId,
    ]);
    await db.query(`insert into campaign (id, org_id, slug) values ($1, $2, $3)`, [
      id,
      orgId,
      slug,
    ]);
  };

  const writerFor = (uuid: string, orgId: string, at: number, hex: string) =>
    new ObjectPackageStore(store, {
      renderPrefix: renderPrefix(orgId, uuid),
      packagePrefix: packagePrefix(orgId, uuid),
      campaignSegment: SLUG,
      now: () => at,
      nonce: () => hex.repeat(32),
    });

  /** A committed package: the render it reads, its files, then the commit. */
  const commitPackage = async (
    uuid: string,
    orgId: string,
    platformId: string,
    rests: readonly string[],
    at: number,
    hex: string,
  ) => {
    const writer = writerFor(uuid, orgId, at, hex);
    await store.put(`${renderPrefix(orgId, uuid)}alpha/1x1.png`, PNG, { contentType: "image/png" });
    for (const rest of rests) await writer.writePackaged(platformId, `${SLUG}/${rest}`, PNG);
    await writer.writeManifest(
      platformId,
      manifestFor(
        platformId,
        rests.map((rest) => manifestItem(platformId, rest)),
      ),
    );
  };

  const listCall = (tenant: TenantContext, campaignId = SLUG) =>
    mountTenantRoute(listHandler, {
      path: "/campaigns/packages/:campaignId",
      tenant,
    })(new Request(`http://x/campaigns/packages/${campaignId}`));

  const zipCall = (tenant: TenantContext, campaignId = SLUG, platformId = PLATFORM) =>
    mountTenantRoute(zipHandler, {
      path: "/campaigns/packages/:campaignId/:platformZip",
      tenant,
    })(new Request(`http://x/campaigns/packages/${campaignId}/${platformId}.zip`));

  const outputCall = (tenant: TenantContext, path: string) =>
    mountTenantRoute(outputHandler, { path: "/output/**:path", tenant })(
      new Request(`http://x/output/${path}`),
    );

  const platformsOf = async (tenant: TenantContext, campaignId = SLUG) => {
    const res = await listCall(tenant, campaignId);
    return {
      status: res.status,
      ids:
        res.status === 200
          ? ((await res.json()) as { platforms: Array<{ platformId: string }> }).platforms.map(
              (p) => p.platformId,
            )
          : [],
    };
  };

  beforeEach(async () => {
    process.env.OBJECT_STORE = "s3";
    harness = await setupPgHarness();
    store = new InMemoryObjectStore();
    // BEFORE anything can build a client: the slot calls `objectStoreClient()`,
    // which would otherwise reach for `S3_*` settings this file never sets.
    setObjectStoreClient(store);
    resetAllStores();
  });

  afterEach(async () => {
    resetAllStores();
    resetObjectStoreClient();
    vi.restoreAllMocks();
    if (SAVED === undefined) delete process.env.OBJECT_STORE;
    else process.env.OBJECT_STORE = SAVED;
    await harness.cleanup();
  });

  test("the listing and the zip are 404 until the manifest exists, and both see the package after", async () => {
    await seedCampaign(harness.db, "local", SLUG, CAMPAIGN);
    const writer = writerFor(CAMPAIGN, "local", EARLY, "a");
    await store.put(`${renderPrefix("local", CAMPAIGN)}alpha/1x1.png`, PNG);
    await writer.writePackaged(PLATFORM, `${SLUG}/alpha/1x1.png`, PNG);

    // Every file is in the bucket and the package is invisible: a PUT is atomic
    // per key, so the manifest written last is the only thing that may be consulted.
    expect(await store.list(`${packagePrefix("local", CAMPAIGN)}${PLATFORM}/`)).toHaveLength(1);
    expect(await platformsOf(LOCAL)).toEqual({ status: 404, ids: [] });
    expect((await zipCall(LOCAL)).status).toBe(404);

    await writer.writeManifest(
      PLATFORM,
      manifestFor(PLATFORM, [manifestItem(PLATFORM, "alpha/1x1.png")]),
    );
    expect(await platformsOf(LOCAL)).toEqual({ status: 200, ids: [PLATFORM] });
    const res = await zipCall(LOCAL);
    expect(res.status).toBe(200);
    expect(parseCentralDirectory(Buffer.from(await res.arrayBuffer())).map((e) => e.name)).toEqual([
      "manifest.json",
      `${SLUG}/alpha/1x1.png`,
    ]);
  });

  test("a crashed manifest-less newer generation beside a committed older one: the route serves the older", async () => {
    await seedCampaign(harness.db, "local", SLUG, CAMPAIGN);
    await commitPackage(CAMPAIGN, "local", PLATFORM, ["alpha/1x1.png"], EARLY, "a");
    // A second writer that got its file down and died before the manifest.
    const crashing = writerFor(CAMPAIGN, "local", LATE, "b");
    await crashing.writePackaged(PLATFORM, `${SLUG}/alpha/16x9.png`, PNG);

    expect(await platformsOf(LOCAL)).toEqual({ status: 200, ids: [PLATFORM] });
    const res = await zipCall(LOCAL);
    expect(res.status).toBe(200);
    // The newer generation's file is NOT in the archive: a customer cannot be
    // handed half of an export that never finished.
    expect(parseCentralDirectory(Buffer.from(await res.arrayBuffer())).map((e) => e.name)).toEqual([
      "manifest.json",
      `${SLUG}/alpha/1x1.png`,
    ]);
  });

  test("pagination: 3 platforms x 3 files at a page size of 2 lists completely, in order, and zips completely", async () => {
    await seedCampaign(harness.db, "local", SLUG, CAMPAIGN);
    store = new InMemoryObjectStore({ listPageSize: 2 });
    setObjectStoreClient(store);
    resetAllStores();
    const rests = ["alpha/1x1.png", "alpha/16x9.png", "beta/9x16.png"];
    for (const platformId of ["tiktok", "instagram-feed", "meta-ads"]) {
      await commitPackage(CAMPAIGN, "local", platformId, rests, EARLY, "a");
    }
    expect(await platformsOf(LOCAL)).toEqual({
      status: 200,
      ids: ["instagram-feed", "meta-ads", "tiktok"],
    });
    for (const platformId of ["instagram-feed", "meta-ads", "tiktok"]) {
      const res = await zipCall(LOCAL, SLUG, platformId);
      expect(res.status).toBe(200);
      // Four entries, complete and sorted, on every platform: a missed page would
      // show up here as a package quietly missing files.
      expect(
        parseCentralDirectory(Buffer.from(await res.arrayBuffer())).map((e) => e.name),
      ).toEqual([
        "manifest.json",
        `${SLUG}/alpha/16x9.png`,
        `${SLUG}/alpha/1x1.png`,
        `${SLUG}/beta/9x16.png`,
      ]);
    }
  });

  test("cross-tenant: another org's slug is 404 from both routes and never asks about this org's prefix", async () => {
    await seedCampaign(harness.db, "local", SLUG, CAMPAIGN);
    await commitPackage(CAMPAIGN, "local", PLATFORM, ["alpha/1x1.png"], EARLY, "a");
    // GLOBEX holds the SAME slug for a campaign of its own — the constraint is
    // `(org_id, slug)`, so the uuid, not the slug, is what keys the objects.
    await seedCampaign(harness.db, "globex", SLUG, OTHER_CAMPAIGN);
    await commitPackage(OTHER_CAMPAIGN, "globex", "tiktok", ["alpha/1x1.png"], LATE, "b");

    const spy = vi.spyOn(store, "list");
    // GLLOBEX asking for LOCAL's slug: its own campaign resolves, its own package
    // is served, and this org's namespace is never probed.
    expect(await platformsOf(OTHER)).toEqual({ status: 200, ids: ["tiktok"] });
    expect((await zipCall(OTHER, SLUG, PLATFORM)).status).toBe(404);
    for (const [prefix] of spy.mock.calls) {
      expect(prefix.startsWith(`org/local/campaign/${CAMPAIGN}/`)).toBe(false);
    }

    // And the reverse: an org with no campaign at all learns nothing, from either
    // route, without a single round trip to the store.
    spy.mockClear();
    const stranger: TenantContext = { orgId: "nobody", userId: "u", roles: [], teamIds: [] };
    await harness.db.query(`insert into org (id, name) values ('nobody', 'Nobody')`);
    expect(await platformsOf(stranger)).toEqual({ status: 404, ids: [] });
    expect((await zipCall(stranger)).status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });

  test("the zip over objects is the fs zip: same entry names, same sizes, same CRCs", async () => {
    await seedCampaign(harness.db, "local", SLUG, CAMPAIGN);
    const rests = ["alpha/1x1.png", "alpha/16x9.png"];
    await commitPackage(CAMPAIGN, "local", PLATFORM, rests, EARLY, "a");
    const s3Zip = parseCentralDirectory(Buffer.from(await (await zipCall(LOCAL)).arrayBuffer()));

    // The SAME package, through the fs writer and the fs output store, on the
    // same campaign. This is the whole compatibility claim: a customer who
    // downloaded a zip from one backend finds the same paths in the other, and the
    // `manifest.json` inside is byte-identical rather than re-serialised.
    process.env.OBJECT_STORE = "fs";
    resetAllStores();
    const fsWriter = new FileSystemPackageStore(harness.outputRoot, SLUG);
    await fsWriter.writePackaged(PLATFORM, `${SLUG}/alpha/1x1.png`, PNG);
    await fsWriter.writePackaged(PLATFORM, `${SLUG}/alpha/16x9.png`, PNG);
    await fsWriter.writeManifest(
      PLATFORM,
      manifestFor(
        PLATFORM,
        rests.map((rest) => manifestItem(PLATFORM, rest)),
      ),
    );
    const fsRes = await zipCall(LOCAL);
    expect(fsRes.status).toBe(200);
    const fsZip = parseCentralDirectory(Buffer.from(await fsRes.arrayBuffer()));

    expect(s3Zip).toEqual(fsZip);
    expect(s3Zip.map((e) => e.name)).toEqual([
      "manifest.json",
      `${SLUG}/alpha/16x9.png`,
      `${SLUG}/alpha/1x1.png`,
    ]);
  });

  test("the generation swept between the listing and the measure pass is a 409, not a 500", async () => {
    await seedCampaign(harness.db, "local", SLUG, CAMPAIGN);
    await commitPackage(CAMPAIGN, "local", PLATFORM, ["alpha/1x1.png"], EARLY, "a");

    // The race, made exact: the platform listing is handed over and the generation
    // it named is emptied a moment later — which is what a newer commit's sweep
    // does, and the only way a committed generation can vanish.
    const prefix = packagePrefix("local", CAMPAIGN);
    const platformPrefix = `${prefix}${PLATFORM}/`;
    const realList = store.list.bind(store);
    let swept: string | undefined;
    vi.spyOn(store, "list").mockImplementation(async (p: string) => {
      const listed = await realList(p);
      if (p === platformPrefix && swept === undefined) {
        swept = latestCommittedGeneration(listed, platformPrefix);
        if (swept !== undefined) {
          await store.deletePrefix(packageGenerationPrefix(prefix, PLATFORM, swept));
        }
      }
      return listed;
    });

    const res = await zipCall(LOCAL);
    // `open()` raises ENOENT for a swept object, and the route's measure pass maps
    // that to the fs backend's own retry answer. An error with no `code` here would
    // be a 500: a client's retry turned into a server fault for the protocol
    // working exactly as designed.
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Package is being rewritten, retry" });
    expect(swept).toBeDefined();
  });

  test("GET /output/** answers 404 under s3 for every shape, and reads no object to say so", async () => {
    await seedCampaign(harness.db, "local", SLUG, CAMPAIGN);
    await commitPackage(CAMPAIGN, "local", PLATFORM, ["alpha/1x1.png"], EARLY, "a");
    const spy = vi.spyOn(store, "get");

    // D204: output is addressed by id and served through a presigned URL, so
    // there is no output-root-relative path a browser can ask this store for — and
    // a render path and a package path are BOTH `missing` rather than one of them
    // `invalid`. That is what keeps this route's answers unchanged from what the
    // web has seen since PT-4e: 404 either way.
    for (const path of [
      "alpha/1x1.png",
      `${SLUG}/alpha/1x1.png`,
      `packages/${SLUG}/${PLATFORM}/manifest.json`,
      // A traversal that survives URL normalisation — `../x` never reaches a
      // handler, because `new Request` collapses it in the URL. Under fs this name
      // is a directory that does not exist, so both backends answer 404 here; what
      // changes is that under s3 even a MALFORMED path is `missing`, never
      // `invalid`, so no path at all can turn into a 400 from this store.
      "%2e%2e%2fsecret",
    ]) {
      const res = await outputCall(LOCAL, path);
      expect(res.status, path).toBe(404);
      expect(await res.json()).toEqual({ error: "Not found" });
    }
    // And nothing was read to decide any of that — the answer is a constant, so
    // this route cannot leak a prefix, a slug or a uuid into a 404.
    expect(spy).not.toHaveBeenCalled();
  });
});
