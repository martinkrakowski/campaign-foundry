import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { renderPrefix } from "../../../lib/object-store/object-keys.js";
import { resetObjectStoreClient, setObjectStoreClient } from "../../../lib/object-store/index.js";
import type { SqlClient } from "../../../lib/db/sql-client.js";
import type { TenantContext } from "../../../lib/tenant.js";
import packageHandler from "../package.post.js";
import {
  mountTenantRoute,
  resetAllStores,
  setupPgHarness,
  type PgHarness,
} from "../../__tests__/tenant-harness.js";

/**
 * `POST /campaigns/package` under `OBJECT_STORE=s3` (PT-4h1, D209f) — the WRITE
 * side, on the pg harness, with an in-memory bucket.
 *
 * A NEW file rather than additions to `packages.test.ts`: that one mocks
 * `node:fs/promises` file-wide, which is exactly the backend this lane stops
 * using, and `routes.test.ts` runs on the fs harness where there is no campaign
 * row to resolve a uuid from. Static handler imports, as
 * `assets.postgres.test.ts` explains — the harness installs one database and one
 * object store for the whole test, and a re-importing helper would rebuild both.
 *
 * **What is asserted here is the prefix, not the package.** PT-4h2 makes the
 * listing and the zip read objects; until then a request answered 200 has written
 * objects that nothing reads. So the claims are: every key lands under this org's
 * and this campaign's `packages/` prefix, and a campaign or an org that has no
 * right to one writes NOTHING at all.
 */

const LOCAL: TenantContext = { orgId: "local", userId: "u", roles: ["owner"], teamIds: [] };
const OTHER: TenantContext = { orgId: "globex", userId: "u", roles: ["owner"], teamIds: [] };
const SLUG = "winter-sale";
const CAMPAIGN = "3f1b7a52-0c4d-4a6e-9b21-5d8e7c6a5b4c";
const OTHER_CAMPAIGN = "00000000-0000-4000-8000-000000000001";
const PLATFORM = "instagram-feed";

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const reportAsset = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  productId: "alpha",
  aspectRatio: "1:1",
  // Slug-prefixed, and deliberately so: `campaignScoped` makes every path the run
  // produces start with the brief's id, and `renderObjectKey` REFUSES a path that
  // does not. `routes.test.ts`'s `alpha/1x1.png` fixtures are fs-only for that
  // reason and must stay that way — weakening the refusal to accommodate them
  // would put the slug back in a key.
  outputPath: `${SLUG}/alpha/1x1.png`,
  treatment: "default",
  complianceScore: 0.5,
  passedCompliance: true,
  logoApplied: true,
  backgroundSource: "procedural",
  ...over,
});

describe("POST /campaigns/package under OBJECT_STORE=s3 (PT-4h1)", () => {
  let harness: PgHarness;
  let store: InMemoryObjectStore;
  const SAVED = process.env.OBJECT_STORE;

  beforeEach(async () => {
    process.env.OBJECT_STORE = "s3";
    harness = await setupPgHarness();
    store = new InMemoryObjectStore();
    // BEFORE anything can build a client: the route calls `objectStoreClient()`,
    // which would otherwise reach for `S3_*` settings this test never sets.
    setObjectStoreClient(store);
    resetAllStores();
    // `local` is seeded by `0001_org.sql`; GLOBEX is this file's own second
    // tenant, which is what makes the cross-tenant case below a real one.
    await harness.db.query(`insert into org (id, name) values ('globex', 'Globex')`);
  });

  afterEach(async () => {
    resetAllStores();
    resetObjectStoreClient();
    vi.restoreAllMocks();
    if (SAVED === undefined) delete process.env.OBJECT_STORE;
    else process.env.OBJECT_STORE = SAVED;
    await harness.cleanup();
  });

  const call = (tenant: TenantContext, body: Record<string, unknown>) =>
    mountTenantRoute(packageHandler, { method: "POST", path: "/campaigns/package", tenant })(
      new Request("http://x/campaigns/package", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  async function seedCampaign(
    db: SqlClient,
    orgId: string,
    slug: string,
    id: string,
  ): Promise<void> {
    await db.query(`insert into campaign (id, org_id, slug) values ($1, $2, $3)`, [
      id,
      orgId,
      slug,
    ]);
  }

  async function seedReport(
    db: SqlClient,
    orgId: string,
    slug: string,
    assets: unknown[] = [reportAsset()],
  ): Promise<void> {
    await db.query(
      `insert into report (org_id, campaign_id, body, revision)
       values ($1, $2, $3, 'rev-1')
       on conflict (org_id, campaign_id) do update set body = excluded.body`,
      [orgId, slug, JSON.stringify({ halted: false, assets, log: { campaignId: slug } })],
    );
  }

  /** The render the report names, already written where the s3 path looks for it.
   *  Written through `renderPrefix` rather than by hand, so a change to that
   *  builder breaks this seed instead of quietly putting the render somewhere the
   *  adapter never reads — which would answer 422 and look like a packaging bug. */
  const seedRender = async (orgId: string, campaignId: string): Promise<void> => {
    await store.put(`${renderPrefix(orgId, campaignId)}alpha/1x1.png`, PNG, {
      contentType: "image/png",
    });
  };

  /** Every key in the store — including the renders this file seeds, which is
   *  why the assertions below compare against a snapshot rather than asserting an
   *  absolute set. A route that wrote outside its prefix shows up as a delta. */
  const everyKey = () => store.list("org/").then((entries) => entries.map((e) => e.key).sort());

  /** The keys the route ADDED, which is the only set that is this request's. */
  const writtenBy = async (before: readonly string[]): Promise<readonly string[]> =>
    (await everyKey()).filter((key) => !before.includes(key));

  test("with no campaign row there is no target, so the request 404s and writes NOTHING", async () => {
    // A report with no campaign row is the case the 404 exists for: under `s3`
    // nothing can have rendered to objects without a target (`buildPipeline`
    // refuses), so an unresolvable campaign is a campaign this org does not have.
    // The report alone must not be enough to package.
    await seedReport(harness.db, "local", SLUG);
    const spy = vi.spyOn(store, "put");
    const res = await call(LOCAL, { campaignId: SLUG, platforms: [PLATFORM] });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Campaign report not found" });
    expect(spy).not.toHaveBeenCalled();
    expect(await everyKey()).toEqual([]);
  });

  test("with a campaign row it writes ONLY under org/<org>/campaign/<uuid>/packages/", async () => {
    await seedCampaign(harness.db, "local", SLUG, CAMPAIGN);
    await seedReport(harness.db, "local", SLUG);
    await seedRender("local", CAMPAIGN);
    const before = await everyKey();

    const res = await call(LOCAL, { campaignId: SLUG, platforms: [PLATFORM] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      platforms: Array<{ platformId: string; manifestPath: string }>;
    };
    expect(body.platforms.map((p) => p.platformId)).toEqual([PLATFORM]);
    // The route's answer names the fs-shaped LOGICAL path, so the manifest a
    // customer receives is the same on both backends and no key leaks into it.
    expect(body.platforms[0]!.manifestPath).toBe(`packages/${SLUG}/${PLATFORM}/manifest.json`);

    const prefix = `org/local/campaign/${CAMPAIGN}/packages/`;
    const written = await writtenBy(before);
    expect(written.length).toBeGreaterThan(0);
    for (const key of written) {
      expect(key.startsWith(prefix)).toBe(true);
      // DoD 3, through the route: a key that carried the slug would be an address
      // that a rename changes.
      expect(key).not.toContain(SLUG);
    }
    // One generation, made live by exactly one manifest.
    expect(written.filter((k) => k.endsWith("manifest.json"))).toHaveLength(1);
    expect(written.some((k) => k.includes("/files/alpha/1x1.png"))).toBe(true);
    // The render is READ from the renders prefix and never copied there: a package
    // that re-wrote its own source would be a second, divergent copy of a creative.
    expect(written.some((k) => k.includes("/renders/"))).toBe(false);
  });

  test("cross-tenant: the same slug in another org is 404 with ZERO store calls, and the owner writes only under its own prefix", async () => {
    await seedCampaign(harness.db, "local", SLUG, CAMPAIGN);
    await seedReport(harness.db, "local", SLUG);
    await seedRender("local", CAMPAIGN);
    const before = await everyKey();

    // GLOBEX holds no campaign by this slug, and no report either — so it learns
    // nothing about the other tenant and, above all, writes nothing. The spy is on
    // the store itself rather than on a helper, so a package written by any path
    // would show up.
    const spy = vi.spyOn(store, "put");
    const denied = await call(OTHER, { campaignId: SLUG, platforms: [PLATFORM] });
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual({ error: "Campaign report not found" });
    expect(spy).not.toHaveBeenCalled();
    expect(await writtenBy(before)).toEqual([]);

    // And GLOBEX holding the SAME slug for one of its own campaigns changes
    // nothing about the owner's namespace: the uuid, not the slug, is what keys it,
    // and a slug is not globally unique — the constraint is `(org_id, slug)`.
    await seedCampaign(harness.db, "globex", SLUG, OTHER_CAMPAIGN);
    await seedReport(harness.db, "globex", SLUG);
    await seedRender("globex", OTHER_CAMPAIGN);
    const granted = await call(OTHER, { campaignId: SLUG, platforms: [PLATFORM] });
    expect(granted.status).toBe(200);

    const written = await writtenBy(before);
    const packages = written.filter((k) => k.includes("/packages/"));
    expect(packages).toHaveLength(2);
    for (const key of packages) {
      expect(key.startsWith(`org/globex/campaign/${OTHER_CAMPAIGN}/packages/`)).toBe(true);
    }
    // Nothing of GLOBEX's package landed under LOCAL's campaign, and vice versa.
    expect(written.some((k) => k.startsWith(`org/local/campaign/${CAMPAIGN}/packages/`))).toBe(
      false,
    );
  });

  test("a failed sweep still answers 200, and says so without naming a key", async () => {
    // The package is committed before the sweep runs, so a bucket that refuses
    // deletes is garbage collection failing and NOT an export that did not finish.
    // Reporting that is the composition root's job (item 1 of fix round 1), and the
    // one thing it must never do is put a key in a log.
    await seedCampaign(harness.db, "local", SLUG, CAMPAIGN);
    await seedReport(harness.db, "local", SLUG);
    await seedRender("local", CAMPAIGN);
    // An older generation for the sweep to try (and be refused) to empty.
    await store.put(
      `org/local/campaign/${CAMPAIGN}/packages/${PLATFORM}/0000000000000-${"a".repeat(32)}/manifest.json`,
      new Uint8Array([1]),
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(store, "deletePrefix").mockRejectedValue(
      new Error("The object store answered 403 to delete."),
    );

    const res = await call(LOCAL, { campaignId: SLUG, platforms: [PLATFORM] });
    expect(res.status).toBe(200);

    const lines = warn.mock.calls.map((args) => String(args[0]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[package] could not sweep older generations");
    // Names the platform, which is the one identifier an operator needs to find
    // the campaign and the one that is not a tenant secret.
    expect(lines[0]).toContain(PLATFORM);
    // And names nothing of the store's namespace: no prefix, no org id, no
    // campaign uuid (DoD 3). `org/` is the substring every key starts with, so it
    // is the sharpest available probe for the whole shape.
    expect(lines[0]).not.toContain("org/");
    expect(lines[0]).not.toContain(CAMPAIGN);
    expect(lines[0]).not.toContain("local");
    // The package itself is committed and complete: the failure was garbage
    // collection, so the manifest a customer gets is exactly the fs-shaped answer.
    const body = (await res.json()) as { platforms: Array<{ manifestPath: string }> };
    expect(body.platforms[0]!.manifestPath).toBe(`packages/${SLUG}/${PLATFORM}/manifest.json`);
    // The refused generation is still there, for the next commit to sweep.
    expect(
      await store.get(
        `org/local/campaign/${CAMPAIGN}/packages/${PLATFORM}/0000000000000-${"a".repeat(32)}/manifest.json`,
      ),
    ).toBeDefined();
  });

  test("a missing render is a 422 whose body is the fs backend's, word for word", async () => {
    await seedCampaign(harness.db, "local", SLUG, CAMPAIGN);
    await seedReport(harness.db, "local", SLUG);
    // No render written: the report names a file nothing ever produced.

    const res = await call(LOCAL, { campaignId: SLUG, platforms: [PLATFORM] });
    expect(res.status).toBe(422);
    const s3Body = (await res.json()) as { error: string };
    // The use case wraps a per-platform failure, so the message names the platform
    // and then the absence — the shape the fs backend produces for the same report.
    expect(s3Body.error).toBe(`Platform "${PLATFORM}": Asset not found: ${SLUG}/alpha/1x1.png`);

    // The same request on `fs`, with the render absent from disk too. Asserting
    // the two bodies are EQUAL is what "the same body on both backends" means —
    // a string asserted twice in one file would only pin this backend.
    process.env.OBJECT_STORE = "fs";
    resetAllStores();
    const fsRes = await call(LOCAL, { campaignId: SLUG, platforms: [PLATFORM] });
    const fsBody = (await fsRes.json()) as { error: string };
    expect(fsRes.status).toBe(422);
    expect(s3Body).toEqual(fsBody);
  });
});
