import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ObjectPackageStore, packageGenerationPrefix } from "@campaignfoundry/Distribution";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import type { PackageManifest, PackageManifestItem } from "@campaignfoundry/Distribution";
import { platformProfile } from "@campaignfoundry/Distribution";
import { packagePrefix, renderPrefix } from "../../object-store/object-keys.js";
import { resetObjectStoreClient, setObjectStoreClient } from "../../object-store/index.js";
import { resetDatabase, setDatabase } from "../../db/database.js";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import type { SqlClient } from "../../db/sql-client.js";
import { LOCAL_TENANT, type TenantContext } from "../../tenant.js";
import { FsOutputStore } from "../fs-output-store.js";
import type { OutputStorePort } from "../output-store.port.js";
import { getOutputStore, resetOutputStore, setOutputStore } from "../index.js";
import { ObjectOutputStore } from "../object-output-store.js";

/**
 * `ObjectOutputStore` against a migrated database and the in-memory object store
 * (PT-4h2, D209f). Offline end to end: no `S3_*` variable is read anywhere in this
 * file, and packages are written by the REAL writer (`ObjectPackageStore`) rather
 * than by hand, so every key this reader looks for was built by the code that
 * would be running in production — a fixture key written by this test would keep
 * passing after the two sides disagreed about the layout.
 *
 * The claims are all about what a reader can see AT A MOMENT IN TIME, for the
 * reason PT-4h1's own suite gives: the only file that makes a generation live is
 * its `manifest.json`, so every question about crash safety and concurrency
 * reduces to whether the live answer changes when it should and only then.
 */

const ORG = "local";
const OTHER_ORG = "globex";
const SLUG = "winter-sale-2026-eu";
const PLATFORM = "instagram-feed";
const EARLY = 1_758_000_000_000;
const LATE = EARLY + 5_000;

const gen = (at: number, hex: string): string =>
  `${String(at).padStart(13, "0")}-${hex.repeat(32)}`;
const EARLY_GEN = gen(EARLY, "a");
const LATE_GEN = gen(LATE, "b");

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

describe("ObjectOutputStore (PT-4h2)", () => {
  let db: SqlClient;
  let store: InMemoryObjectStore;
  let outputs: ObjectOutputStore;
  let campaignId: string;

  const seed = async (orgId: string, slug: string): Promise<string> => {
    // `campaign.org_id` references `org`, and unlike the harness this file runs
    // no migration seeding: GLLOBEX and NOBODY are its own second and third
    // tenants, and the cross-org cases below are meaningless without the rows.
    await db.query(`insert into org (id, name) values ($1, $2) on conflict do nothing`, [
      orgId,
      orgId,
    ]);
    const { rows } = await db.query<{ id: string }>(
      `insert into campaign (org_id, slug) values ($1, $2) returning id`,
      [orgId, slug],
    );
    return rows[0]!.id;
  };

  /** The reader this file is about, for `orgId` rather than the outer one. */
  const readerFor = (orgId: string): ObjectOutputStore => new ObjectOutputStore(db, store, orgId);

  /**
   * A fresh writer, so the next `writePackaged` mints a NEW generation rather than
   * joining this one's. The clock and the nonce are injected because "newer" has
   * to be a fact and not an ordering of puts: `InMemoryObjectStore` answers
   * `list` in insertion order, so a writer that ran "later" in the test could
   * mint an OLDER-looking segment and every reader would sort it first.
   */
  const writerFor = (uuid: string, orgId: string, at: number, hex: string): ObjectPackageStore =>
    new ObjectPackageStore(store, {
      renderPrefix: renderPrefix(orgId, uuid),
      packagePrefix: packagePrefix(orgId, uuid),
      campaignSegment: SLUG,
      now: () => at,
      nonce: () => hex.repeat(32),
    });

  const manifestItem = (platformId: string, rest: string): PackageManifestItem => ({
    productId: "p1",
    aspectRatio: "1x1",
    treatment: "classic",
    format: "static",
    source: `${SLUG}/alpha/1x1.png`,
    // The fs-shaped LOGICAL path the writer returns — `packages/<slug>/<platform>/
    // <slug>/<rest>` — and the reason the reader restores `<slug>/<rest>`: the
    // campaign-scoped relative path, with the segment the KEY dropped.
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
    // The real profile, so a manifest written here is shaped exactly as the use
    // case's is — a hand-written stub would let the two drift and the reader
    // would be tested against a manifest nothing else in the system produces.
    profile: platformProfile(platformId)!,
    items: [...items],
  });

  /** A committed package: the render it reads, its files, then the commit. */
  const commitPackage = async (
    uuid: string,
    platformId: string,
    rest: string,
    at: number,
    hex: string,
  ): Promise<void> => commitFiles(uuid, platformId, [rest], at, hex);

  /** A committed package holding SEVERAL files, for the pagination case. */
  const commitFiles = async (
    uuid: string,
    platformId: string,
    rests: readonly string[],
    at: number,
    hex: string,
  ): Promise<void> => {
    const writer = writerFor(uuid, ORG, at, hex);
    await store.put(`${renderPrefix(ORG, uuid)}alpha/1x1.png`, PNG, { contentType: "image/png" });
    for (const rest of rests) {
      await writer.writePackaged(platformId, `${SLUG}/${rest}`, PNG);
    }
    await writer.writeManifest(
      platformId,
      manifestFor(
        platformId,
        rests.map((rest) => manifestItem(platformId, rest)),
      ),
    );
  };

  /** Everything a stream from an entry yields, as one buffer. */
  const collect = async (entry: { open(): NodeJS.ReadableStream }): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    for await (const chunk of entry.open()) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  };

  beforeEach(async () => {
    db = await migratedDatabase();
    setDatabase(db);
    store = new InMemoryObjectStore();
    outputs = readerFor(ORG);
    campaignId = await seed(ORG, SLUG);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resetObjectStoreClient();
    resetDatabase();
    await db.end();
  });

  describe("openOutput", () => {
    test("answers missing for a render path, a package path and a traversal, on every backend branch", async () => {
      // D204: output is addressed by id and served through a presigned URL, so
      // there is no output-root-relative path for a browser to ask this store for.
      // `missing` and not `invalid` is what makes a malformed path a 404 rather
      // than a 400 — a URL that cannot name an object cannot be a valid one.
      for (const path of [
        "alpha/1x1.png",
        `packages/${SLUG}/${PLATFORM}/manifest.json`,
        "../x",
        "",
        "%2e%2e/x",
      ]) {
        expect(await outputs.openOutput(path)).toEqual({ found: false, reason: "missing" });
      }
      // And it reads no key while doing it, so nothing here can leak a prefix.
      const spy = vi.spyOn(store, "get");
      expect(await outputs.openOutput("alpha/1x1.png")).toEqual({
        found: false,
        reason: "missing",
      });
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe("listPackageManifests", () => {
    test("the commit point, seen from the READ side: nothing until the manifest exists", async () => {
      // A writer that wrote its files and stopped. Every file is there and the
      // package is invisible, which is the whole of PT-4h1's commit protocol read
      // back: a PUT is atomic per key, so without the manifest the reader would be
      // reading whichever prefix of the package happened to land.
      const writer = writerFor(campaignId, ORG, EARLY, "a");
      await store.put(`${renderPrefix(ORG, campaignId)}alpha/1x1.png`, PNG);
      await writer.writePackaged(PLATFORM, `${SLUG}/alpha/1x1.png`, PNG);
      expect(await store.list(`${packagePrefix(ORG, campaignId)}${PLATFORM}/`)).toHaveLength(1);

      expect(await outputs.listPackageManifests(SLUG)).toEqual([]);
      expect(await outputs.listPackageFiles(SLUG, PLATFORM)).toBeUndefined();

      await writer.writeManifest(
        PLATFORM,
        manifestFor(PLATFORM, [manifestItem(PLATFORM, "alpha/1x1.png")]),
      );
      const listed = await outputs.listPackageManifests(SLUG);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ platformId: PLATFORM, campaignId: SLUG });
      expect((await outputs.listPackageFiles(SLUG, PLATFORM))?.map((e) => e.name)).toEqual([
        // `manifest.json` sorts among the files by the same localeCompare the fs
        // walk uses, so the archive is in the same order on both backends.
        "manifest.json",
        `${SLUG}/alpha/1x1.png`,
      ]);
    });

    test("a crashed manifest-less generation beside a committed older one: the reader serves the committed one", async () => {
      await commitPackage(campaignId, PLATFORM, "alpha/1x1.png", EARLY, "a");
      // A second writer that got its files down and died before the manifest.
      const crashing = writerFor(campaignId, ORG, LATE, "b");
      await crashing.writePackaged(PLATFORM, `${SLUG}/alpha/16x9.png`, PNG);
      expect(await store.list(`${packagePrefix(ORG, campaignId)}${PLATFORM}/`)).toHaveLength(3);

      // The listing answers the OLD package — not the newer one, and not none.
      const listed = await outputs.listPackageManifests(SLUG);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        items: [expect.objectContaining({ packagedPath: expect.stringContaining("1x1.png") })],
      });
      // And so does the zip: the newer generation's file is not in it, so a
      // customer cannot be handed half of an export that never finished.
      const names = (await outputs.listPackageFiles(SLUG, PLATFORM))?.map((e) => e.name);
      expect(names).toEqual(["manifest.json", `${SLUG}/alpha/1x1.png`]);
    });

    test("orders platforms by localeCompare, and skips a segment that is not a package", async () => {
      // Written in a deliberately unsorted order: `InMemoryObjectStore` lists in
      // INSERTION order where a real bucket lists in key order, so an
      // implementation that trusted the listing would pass offline and sort the
      // same way in production — and neither would match fs.
      for (const platformId of ["tiktok", "instagram-feed", "meta-ads"]) {
        await commitPackage(campaignId, platformId, "alpha/1x1.png", EARLY, "a");
      }
      expect((await outputs.listPackageManifests(SLUG)).length).toBe(3);

      const prefix = packagePrefix(ORG, campaignId);
      // Keys that are not package keys, from another writer or an older layout:
      // a platform id that fails `SAFE_ID`, a platform segment that is followed by
      // something that is not a generation, and a bare key with no second segment.
      await store.put(`${prefix}Not_Valid/${LATE_GEN}/manifest.json`, PNG);
      await store.put(`${prefix}legacy/manifest.json`, PNG);
      await store.put(`${prefix}meta/${gen(LATE, "c")}/files/alpha/1x1.png`, PNG);
      await store.put(`${prefix}stray/${gen(LATE, "c")}/files/alpha/1x1.png`, PNG);
      await store.put(`${prefix}README`, PNG);

      const listed = await outputs.listPackageManifests(SLUG);
      expect(listed.map((m) => (m as { platformId: string }).platformId)).toEqual([
        "instagram-feed",
        // `meta` and `meta-ads` are different platforms: the platform segment is
        // read as a segment, never sliced off a longer key, so one platform can
        // never answer with another's manifest.
        "meta-ads",
        "tiktok",
      ]);
    });

    test("skips a manifest that is not an object, and one that does not parse", async () => {
      await commitPackage(campaignId, PLATFORM, "alpha/1x1.png", EARLY, "a");
      const prefix = packagePrefix(ORG, campaignId);
      for (const [platformId, body] of [
        ["array-json", "[]"],
        ["null-json", "null"],
        ["bad-json", "{"],
      ] as const) {
        const key = `${prefix}${platformId}/${gen(LATE, "d")}/manifest.json`;
        await store.put(key, new TextEncoder().encode(body), { contentType: "application/json" });
      }
      const listed = await outputs.listPackageManifests(SLUG);
      expect(listed.map((m) => (m as { platformId: string }).platformId)).toEqual([PLATFORM]);
    });

    test("a ref this org does not have lists nothing, and an unsafe one answers without a query", async () => {
      expect(await outputs.listPackageManifests("no-such-campaign")).toEqual([]);
      expect(await outputs.listPackageManifests("Not_Valid")).toEqual([]);
      const spy = vi.spyOn(db, "query");
      expect(await outputs.listPackageManifests("Not_Valid")).toEqual([]);
      expect(spy).not.toHaveBeenCalled();
    });

    test("a store that REFUSES propagates rather than looking like an empty campaign", async () => {
      await commitPackage(campaignId, PLATFORM, "alpha/1x1.png", EARLY, "a");
      vi.spyOn(store, "list").mockRejectedValue(new Error("The object store answered 503."));
      // An empty listing here would tell the caller its campaign has no packages.
      await expect(outputs.listPackageManifests(SLUG)).rejects.toThrow("answered 503");
    });
  });

  describe("the re-list retry", () => {
    test("a manifest swept between the list and the get is re-listed once and the NEW generation is served", async () => {
      await commitPackage(campaignId, PLATFORM, "alpha/1x1.png", EARLY, "a");
      // A second generation, committed but NOT swept: this is the store's state
      // between the newer commit's manifest PUT and its `deletePrefix`, which is
      // exactly the window a reader that listed a moment earlier can be standing in.
      const prefix = `${packagePrefix(ORG, campaignId)}${PLATFORM}/`;
      await store.put(`${prefix}${LATE_GEN}/files/${SLUG}/alpha/16x9.png`, PNG);
      await store.put(
        `${prefix}${LATE_GEN}/manifest.json`,
        new TextEncoder().encode(
          JSON.stringify(manifestFor(PLATFORM, [manifestItem(PLATFORM, "alpha/16x9.png")])),
        ),
        { contentType: "application/json" },
      );

      const realList = store.list.bind(store);
      const realGet = store.get.bind(store);
      let firstListing = true;
      const listed: string[] = [];
      vi.spyOn(store, "list").mockImplementation(async (p: string) => {
        listed.push(p);
        const current = await realList(p);
        // The FIRST listing is the one taken before the newer generation existed —
        // so it answers EARLY_GEN, which the sweep below has already emptied.
        if (firstListing && p === packagePrefix(ORG, campaignId)) {
          firstListing = false;
          return current.filter((entry) => entry.key.includes(EARLY_GEN));
        }
        return current;
      });
      vi.spyOn(store, "get").mockImplementation(async (key: string) => {
        // The swept manifest: the listing named it, and it is gone.
        return key.includes(EARLY_GEN) ? undefined : realGet(key);
      });

      const manifests = await outputs.listPackageManifests(SLUG);
      // The NEW package, served from the re-listing — not the old one, and not
      // nothing, which is what answering `undefined` here would have looked like.
      expect(manifests).toHaveLength(1);
      expect(manifests[0]).toMatchObject({
        items: [expect.objectContaining({ packagedPath: expect.stringContaining("16x9.png") })],
      });
      // Exactly one retry, on that platform's prefix and nothing else.
      expect(listed.filter((p) => p === prefix)).toHaveLength(1);
      expect(listed.filter((p) => p === packagePrefix(ORG, campaignId))).toHaveLength(1);
    });

    test("a manifest that is still missing after the retry skips that platform and serves the others", async () => {
      await commitPackage(campaignId, PLATFORM, "alpha/1x1.png", EARLY, "a");
      await commitPackage(campaignId, "tiktok", "alpha/1x1.png", EARLY, "a");
      const realGet = store.get.bind(store);
      // One platform's manifest is readable, the other's is not even after the
      // retry: not a race, a bucket that will not serve those objects.
      vi.spyOn(store, "get").mockImplementation((key: string) =>
        key.includes(PLATFORM) ? Promise.resolve(undefined) : realGet(key),
      );
      const listSpy = vi.spyOn(store, "list");

      const listed = await outputs.listPackageManifests(SLUG);
      // The unreadable platform is skipped and the readable one is still served —
      // one platform's unreadable manifest must not cost a campaign the others.
      expect(listed.map((m) => (m as { platformId: string }).platformId)).toEqual(["tiktok"]);
      const prefixes = listSpy.mock.calls.map(([p]) => p);
      // Retried once for the platform that failed, and not at all for the one that
      // answered: once, not in a loop.
      expect(
        prefixes.filter((p) => p === `${packagePrefix(ORG, campaignId)}${PLATFORM}/`),
      ).toHaveLength(1);
      expect(prefixes.filter((p) => p === `${packagePrefix(ORG, campaignId)}tiktok/`)).toHaveLength(
        0,
      );
    });

    test("a re-list that finds no committed generation at all skips the platform", async () => {
      await commitPackage(campaignId, PLATFORM, "alpha/1x1.png", EARLY, "a");
      await commitPackage(campaignId, "tiktok", "alpha/1x1.png", EARLY, "a");
      // The campaign is DELETED between the campaign-level listing and the
      // manifest read: the objects go, the `get` answers `undefined` and the
      // re-list finds an empty prefix. Skipping the platform is the honest answer
      // — there is no package — and it is what keeps the retry from answering
      // "this campaign has no packages", which is a different claim entirely.
      const realGet = store.get.bind(store);
      let deleted = false;
      vi.spyOn(store, "get").mockImplementation(async (key: string) => {
        if (!deleted) {
          deleted = true;
          await store.deletePrefix(packagePrefix(ORG, campaignId));
        }
        return realGet(key);
      });

      expect(
        (await outputs.listPackageManifests(SLUG)).map(
          (m) => (m as { platformId: string }).platformId,
        ),
      ).toEqual([]);
    });
  });

  describe("listPackageFiles", () => {
    test("names each entry <slug>/<rest> plus manifest.json, sorted, and opens the fs bytes", async () => {
      await commitPackage(campaignId, PLATFORM, "alpha/16x9.png", EARLY, "a");
      const entries = await outputs.listPackageFiles(SLUG, PLATFORM);
      expect(entries?.map((e) => e.name)).toEqual([
        // `manifest.json` sorts among them by the same localeCompare the fs walk
        // uses, so the archive is in the same order on both backends.
        "manifest.json",
        `${SLUG}/alpha/16x9.png`,
      ]);
      const named = (name: string) => entries!.find((e) => e.name === name)!;
      expect(Buffer.from(await collect(named(`${SLUG}/alpha/16x9.png`)))).toEqual(Buffer.from(PNG));
      // The manifest entry is the generation's own manifest, not a copy of
      // something re-serialised here — so its bytes are the writer's, indentation
      // and all, and a customer can diff two zips of the same package.
      expect(Buffer.from(await collect(named("manifest.json"))).toString("utf8")).toContain(
        `"platformId": "${PLATFORM}"`,
      );
    });

    test("answers undefined for an unsafe platform, an unsafe slug, or a ref this org lacks", async () => {
      await commitPackage(campaignId, PLATFORM, "alpha/1x1.png", EARLY, "a");
      expect(await outputs.listPackageFiles(SLUG, "Not_Valid")).toBeUndefined();
      expect(await outputs.listPackageFiles("Not_Valid", PLATFORM)).toBeUndefined();
      expect(await outputs.listPackageFiles("no-such-campaign", PLATFORM)).toBeUndefined();
      // A platform with no committed generation: its folder exists on disk for fs,
      // and here its prefix simply holds nothing readable.
      expect(await outputs.listPackageFiles(SLUG, "tiktok")).toBeUndefined();
    });

    test("an object that IS the files prefix names nothing and is skipped", async () => {
      await commitPackage(campaignId, PLATFORM, "alpha/1x1.png", EARLY, "a");
      // A legal key (`assertObjectKey` admits a trailing separator) that holds no
      // path at all. Naming it `<slug>/` would put a directory entry in a zip that
      // contains no directory, and unzip would then create an empty folder inside
      // a customer's download.
      const filesPrefix = `${packageGenerationPrefix(
        packagePrefix(ORG, campaignId),
        PLATFORM,
        EARLY_GEN,
      )}files/`;
      await store.put(filesPrefix, PNG);

      const names = (await outputs.listPackageFiles(SLUG, PLATFORM))?.map((e) => e.name);
      expect(names).toEqual(["manifest.json", `${SLUG}/alpha/1x1.png`]);
      expect(names).not.toContain(`${SLUG}/`);
    });

    test("open() throws ENOENT for an object that is gone, and yields no empty chunk", async () => {
      await commitPackage(campaignId, PLATFORM, "alpha/1x1.png", EARLY, "a");
      const entries = await outputs.listPackageFiles(SLUG, PLATFORM);
      const entry = entries![0]!;

      // An empty object is a legal write and must produce no zero-length chunk —
      // `storeZipStream` yields one straight into the response, which leaves it
      // open on Node 22.
      vi.spyOn(store, "get").mockResolvedValue({ bytes: new Uint8Array(0) });
      expect(await collect(entry)).toEqual(Buffer.alloc(0));

      // And a swept object is ENOENT, which the route's measure pass turns into a
      // 409 "Package is being rewritten, retry" — the truthful answer, because a
      // newer commit DID supersede this generation between the list and the read.
      vi.spyOn(store, "get").mockResolvedValue(undefined);
      const code = await collect(entry).then(
        () => undefined,
        (error: unknown) => (error as { code?: string }).code,
      );
      expect(code).toBe("ENOENT");
    });

    test("one listing answers the whole platform, whatever the store's page size", async () => {
      // Pagination is the store's job and the port already promises a caller never
      // sees a page (`ObjectStorePort.list`), so what this asks is the reader's:
      // 3 platforms x 3 files at a page size of 2 means the writer's own listing
      // and every read here page at least twice, and a reader that paged per
      // platform or per file would still answer the same NAMES — the order and
      // completeness are what a caller would notice, and a missed page would show
      // up as a package quietly missing files.
      store = new InMemoryObjectStore({ listPageSize: 2 });
      outputs = readerFor(ORG);
      const rests = ["alpha/1x1.png", "alpha/16x9.png", "beta/9x16.png"];
      for (const platformId of ["tiktok", "instagram-feed", "meta-ads"]) {
        await commitFiles(campaignId, platformId, rests, EARLY, "a");
      }
      const listed = await outputs.listPackageManifests(SLUG);
      expect(listed.map((m) => (m as { platformId: string }).platformId)).toEqual([
        "instagram-feed",
        "meta-ads",
        "tiktok",
      ]);
      // Complete AND ordered: 3 files plus the manifest, sorted, for every platform.
      for (const platformId of ["instagram-feed", "meta-ads", "tiktok"]) {
        expect((await outputs.listPackageFiles(SLUG, platformId))?.map((e) => e.name)).toEqual([
          "manifest.json",
          `${SLUG}/alpha/16x9.png`,
          `${SLUG}/alpha/1x1.png`,
          `${SLUG}/beta/9x16.png`,
        ]);
      }
      // Four objects under the platform prefix, listed across two pages.
      expect(await store.list(`${packagePrefix(ORG, campaignId)}${PLATFORM}/`)).toHaveLength(4);
    });
  });

  describe("cross-org", () => {
    test("the same slug in another org resolves to another campaign, and each reads only its own", async () => {
      const theirs = await seed(OTHER_ORG, SLUG);
      await commitPackage(campaignId, PLATFORM, "alpha/1x1.png", EARLY, "a");
      // GLLOBEX packages the SAME slug — the constraint is `(org_id, slug)`, so a
      // slug is not globally unique and the uuid is the only thing that separates
      // the two namespaces.
      const writer = new ObjectPackageStore(store, {
        renderPrefix: renderPrefix(OTHER_ORG, theirs),
        packagePrefix: packagePrefix(OTHER_ORG, theirs),
        campaignSegment: SLUG,
        now: () => LATE,
        nonce: () => "c".repeat(32),
      });
      await store.put(`${renderPrefix(OTHER_ORG, theirs)}alpha/1x1.png`, PNG);
      await writer.writePackaged("tiktok", `${SLUG}/alpha/1x1.png`, PNG);
      await writer.writeManifest(
        "tiktok",
        manifestFor("tiktok", [manifestItem("tiktok", "alpha/1x1.png")]),
      );

      const globex = readerFor(OTHER_ORG);
      expect(
        (await globex.listPackageManifests(SLUG)).map(
          (m) => (m as { platformId: string }).platformId,
        ),
      ).toEqual(["tiktok"]);
      // And the owner sees only its own package, never GLLOBEX's.
      expect(
        (await outputs.listPackageManifests(SLUG)).map(
          (m) => (m as { platformId: string }).platformId,
        ),
      ).toEqual([PLATFORM]);
      expect(await outputs.listPackageFiles(SLUG, "tiktok")).toBeUndefined();

      // The decisive assertion: GLLOBEX never so much as ASKS about the owner's
      // namespace. `org/local/campaign/<uuid>/packages/` is not in the set of
      // prefixes it listed, which is what an `org_id`-less slug lookup would do.
      const spy = vi.spyOn(store, "list");
      await globex.listPackageManifests(SLUG);
      await globex.listPackageFiles(SLUG, "tiktok");
      for (const [prefix] of spy.mock.calls) {
        expect(prefix.startsWith(`org/${OTHER_ORG}/campaign/${theirs}/`)).toBe(true);
      }
    });

    test("an org with no campaign by that slug lists nothing and reads no prefix", async () => {
      await commitPackage(campaignId, PLATFORM, "alpha/1x1.png", EARLY, "a");
      const empty = readerFor("nobody");
      const spy = vi.spyOn(store, "list");
      expect(await empty.listPackageManifests(SLUG)).toEqual([]);
      expect(await empty.listPackageFiles(SLUG, PLATFORM)).toBeUndefined();
      // Not one round trip: the slug did not resolve, so there is no prefix to ask
      // about — which is also why the owner's namespace cannot be probed for.
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe("the outputs slot in lib/ports/index.ts", () => {
    const SAVED = process.env.OBJECT_STORE;

    beforeEach(() => {
      // BEFORE any `getOutputStore`: the slot calls `objectStoreClient()`, which
      // would otherwise reach for `S3_*` settings this file never sets.
      setObjectStoreClient(store);
      resetOutputStore();
    });

    afterEach(() => {
      resetOutputStore();
      if (SAVED === undefined) delete process.env.OBJECT_STORE;
      else process.env.OBJECT_STORE = SAVED;
    });

    test("under s3 it is an ObjectOutputStore, per org; under fs it is an FsOutputStore", () => {
      process.env.OBJECT_STORE = "s3";
      resetOutputStore();
      const acme: TenantContext = { orgId: OTHER_ORG, userId: "u", roles: [], teamIds: [] };

      const built = getOutputStore(LOCAL_TENANT);
      expect(built).toBeInstanceOf(ObjectOutputStore);
      // Per ORG and not per output root, exactly like the assets slot: the
      // adapter's own query is org-scoped and its keys carry the org, so a root
      // that named a directory instead would hand one org another org's uuid.
      // And one org's requests share the instance, the reason a registry exists.
      expect(getOutputStore(LOCAL_TENANT)).toBe(built);
      expect(getOutputStore(acme)).toBeInstanceOf(ObjectOutputStore);
      expect(getOutputStore(acme)).not.toBe(built);

      // The override still wins on both backends — it is what every fs suite uses.
      const stub = {} as OutputStorePort;
      setOutputStore(stub);
      expect(getOutputStore(LOCAL_TENANT)).toBe(stub);
      resetOutputStore();

      process.env.OBJECT_STORE = "fs";
      resetOutputStore();
      // Unchanged, down to the root it builds: under fs the two `packages/` routes
      // must keep walking the output volume byte for byte.
      expect(getOutputStore(LOCAL_TENANT)).toBeInstanceOf(FsOutputStore);
      expect(getOutputStore(LOCAL_TENANT)).toBe(getOutputStore(LOCAL_TENANT));
    });
  });
});
