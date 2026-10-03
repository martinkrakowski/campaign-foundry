import { describe, test, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  GeneratedAsset,
  ListedObject,
  ObjectStorePort,
} from "@campaignfoundry/CampaignOrchestration";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { PackageForPlatformUseCase } from "../../../application/use-cases/PackageForPlatformUseCase.use-case.js";
import type {
  PackageManifest,
  PackageManifestItem,
} from "../../../application/ports/out/PackageStorePort.js";
import { platformProfile } from "../../../domain/value-objects/PlatformProfile.vo.js";
import { FileSystemPackageStore } from "../FileSystemPackageStore.js";
import {
  ObjectPackageStore,
  PACKAGE_GENERATION_PATTERN,
  latestCommittedGeneration,
  packageGenerationPrefix,
} from "../ObjectPackageStore.js";

/**
 * `ObjectPackageStore` offline (PT-4h1, D209f), against `InMemoryObjectStore`.
 *
 * The claims under test are all about the GENERATION protocol, so most of these
 * ask a question about what a READER could see at a moment in time rather than
 * about what was written: the only file that makes a generation live is its
 * `manifest.json`, and every question about crash safety, concurrency and
 * sweeping reduces to whether the live answer changes when it should and only
 * then.
 *
 * `InMemoryObjectStore.list` answers in INSERTION order where a real bucket
 * answers in key order, so any implementation that trusted the listing order
 * would pass here and fail in production. That asymmetry is the point of the
 * reverse-and-shuffled cases below: the reader must sort for itself.
 */

const ORG = "acme";
const CAMPAIGN = "3f1b7a52-0c4d-4a6e-9b21-5d8e7c6a5b4c";
const OTHER_CAMPAIGN = "00000000-0000-4000-8000-000000000001";
const RENDERS = `org/${ORG}/campaign/${CAMPAIGN}/renders/`;
const PACKAGES = `org/${ORG}/campaign/${CAMPAIGN}/packages/`;
/** Distinctive on purpose: DoD 3 is only a real assertion if a human would
 *  recognise the string in a key. */
const SLUG = "winter-sale-2026-eu";
const PLATFORM = "instagram-feed";
const PLATFORM_PREFIX = `${PACKAGES}${PLATFORM}/`;
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const MP4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
const HTML = new Uint8Array(Buffer.from("<html><body>bundle</body></html>", "utf8"));

/** Two fixed clock readings, so "newer" is a fact and not an ordering of puts. */
const EARLY = 1_758_000_000_000;
const LATE = EARLY + 5_000;
const LATER = LATE + 5_000;

const nonce = (hex: string) => (): string => hex.repeat(32);
const gen = (at: number, hex: string) => `${String(at).padStart(13, "0")}-${hex.repeat(32)}`;

const EARLY_GEN = gen(EARLY, "a");
const LATE_GEN = gen(LATE, "b");
const LATER_GEN = gen(LATER, "c");

/** A listed object with a synthetic timestamp — `latestCommittedGeneration` reads
 *  only keys, and asserting that is easier with a stable shape. */
const entry = (key: string, at = EARLY): ListedObject => ({
  key,
  size: 1,
  lastModified: new Date(at),
});

const manifestItem = (over: Partial<PackageManifestItem> = {}): PackageManifestItem => ({
  productId: "p1",
  aspectRatio: "1:1",
  treatment: "classic",
  format: "static",
  source: `${SLUG}/alpha/1x1.png`,
  packagedPath: `packages/${SLUG}/${PLATFORM}/${SLUG}/alpha/1x1.png`,
  bytes: PNG.length,
  checks: { size: "pass" },
  ...over,
});

const manifest = (over: Partial<PackageManifest> = {}): PackageManifest => ({
  campaignId: SLUG,
  platformId: PLATFORM,
  packagedAt: "2026-08-25T12:00:00.000Z",
  skipped: 0,
  included: 1,
  excluded: 0,
  profile: platformProfile(PLATFORM)!,
  items: [manifestItem()],
  ...over,
});

/** A store whose `deletePrefix` refuses, so a cleanup failure is a fact and not a
 *  hypothesis. Everything else is delegated, so the commit still happens. */
function storeWithBrokenCleanup(inner: InMemoryObjectStore): ObjectStorePort {
  return new Proxy(inner, {
    get(target, property, receiver) {
      if (property !== "deletePrefix") {
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async () => {
        throw new Error("the bucket refused the sweep");
      };
    },
  });
}

describe("the package generation layout", () => {
  test("packageGenerationPrefix is <platformId>/<generation>/ with a trailing separator", () => {
    expect(packageGenerationPrefix(PACKAGES, PLATFORM, EARLY_GEN)).toBe(
      `${PLATFORM_PREFIX}${EARLY_GEN}/`,
    );
    // Everything a package writes starts with it, including the manifest that
    // commits the generation — which is what makes one prefix the whole of it.
    expect(
      `${PLATFORM_PREFIX}${EARLY_GEN}/manifest.json`.startsWith(
        packageGenerationPrefix(PACKAGES, PLATFORM, EARLY_GEN),
      ),
    ).toBe(true);
    expect(
      `${PLATFORM_PREFIX}${EARLY_GEN}/files/alpha/1x1.png`.startsWith(
        packageGenerationPrefix(PACKAGES, PLATFORM, EARLY_GEN),
      ),
    ).toBe(true);
  });

  test("a platform prefix cannot match a neighbour: `meta` is not `meta-ads`", () => {
    const meta = packageGenerationPrefix(PACKAGES, "meta", EARLY_GEN);
    const metaAds = packageGenerationPrefix(PACKAGES, "meta-ads", LATE_GEN);
    // The trailing separator is the whole of it. A prefix without one would make
    // the sweep at commit time empty `meta-ads/` while committing `meta/`.
    expect(meta.startsWith(`${PACKAGES}meta/`)).toBe(true);
    expect(metaAds.startsWith(`${PACKAGES}meta/`)).toBe(false);
    expect(meta).not.toBe(metaAds);
  });

  describe("the platform id is checked before it can name a namespace", () => {
    const MARKER = "MARKER-7f3a";
    const refused: readonly (readonly [string, string])[] = [
      ["an empty platform id", ""],
      ["a dot", "."],
      ["a parent directory", ".."],
      ["a platform id holding a slash", `feed/${MARKER}`],
      ["a platform id holding a slash that climbs", "../.."],
      ["a platform id with a space", "meta ads"],
      ["a platform id over 64 characters", "p".repeat(65)],
    ];

    for (const [what, platformId] of refused) {
      test(`${what} is refused, naming the parameter and not the value`, () => {
        expect(() => packageGenerationPrefix(PACKAGES, platformId, EARLY_GEN)).toThrow(
          /^Refusing an object key: the platform id/,
        );
        expect(() => packageGenerationPrefix(PACKAGES, platformId, EARLY_GEN)).not.toThrow(MARKER);
      });
    }
  });

  test("PACKAGE_GENERATION_PATTERN is a fixed-width stamp and a 32-char lowercase nonce", () => {
    // What a real store accepts from this adapter.
    expect(PACKAGE_GENERATION_PATTERN.test(EARLY_GEN)).toBe(true);
    // A 12-digit stamp sorts wrong against a 13-digit one, which would make
    // "newest wins" wrong for every date before 2001.
    expect(PACKAGE_GENERATION_PATTERN.test(gen(EARLY, "a").slice(1))).toBe(false);
    // Upper case would sort BELOW every lower-case nonce at the same stamp.
    expect(PACKAGE_GENERATION_PATTERN.test(gen(EARLY, "A"))).toBe(false);
    // A uuid, a bare stamp and an fs-style staging suffix are all refused: none of
    // them is something `writePackaged` can mint.
    expect(PACKAGE_GENERATION_PATTERN.test(CAMPAIGN)).toBe(false);
    expect(PACKAGE_GENERATION_PATTERN.test("01758000000000")).toBe(false);
    expect(PACKAGE_GENERATION_PATTERN.test(`${EARLY_GEN}.staging-abc`)).toBe(false);
  });
});

describe("latestCommittedGeneration", () => {
  test("nothing committed answers undefined, however many files are listed", () => {
    expect(latestCommittedGeneration([], PLATFORM_PREFIX)).toBeUndefined();
    // A crash mid-write: files, no manifest.
    expect(
      latestCommittedGeneration(
        [
          entry(`${PLATFORM_PREFIX}${EARLY_GEN}/files/alpha/1x1.png`),
          entry(`${PLATFORM_PREFIX}${EARLY_GEN}/files/beta/1x1.png`),
        ],
        PLATFORM_PREFIX,
      ),
    ).toBeUndefined();
  });

  test("it picks the MAX committed generation from keys in REVERSE order", () => {
    expect(
      latestCommittedGeneration(
        [
          entry(`${PLATFORM_PREFIX}${LATER_GEN}/manifest.json`),
          entry(`${PLATFORM_PREFIX}${LATE_GEN}/manifest.json`),
          entry(`${PLATFORM_PREFIX}${EARLY_GEN}/manifest.json`),
        ],
        PLATFORM_PREFIX,
      ),
    ).toBe(LATER_GEN);
  });

  test("it picks the max from a SHUFFLED listing, and never trusts the order", () => {
    const keys = [EARLY_GEN, LATER_GEN, LATE_GEN].map((g) =>
      entry(`${PLATFORM_PREFIX}${g}/manifest.json`),
    );
    for (const order of [
      [keys[1]!, keys[0]!, keys[2]!],
      [keys[2]!, keys[1]!, keys[0]!],
      [keys[0]!, keys[2]!, keys[1]!],
    ]) {
      expect(latestCommittedGeneration(order, PLATFORM_PREFIX)).toBe(LATER_GEN);
    }
  });

  test("newest wins by the KEY, never by the timestamp the store reports", () => {
    // The newer generation was written FIRST in wall-clock terms by the fake's
    // clock, and a reader that trusted `lastModified` would pick the older one.
    // A real bucket's `lastModified` is server time and this store's is injected;
    // the generation segment is the only order the two backends agree on.
    expect(
      latestCommittedGeneration(
        [
          entry(`${PLATFORM_PREFIX}${LATER_GEN}/manifest.json`, EARLY),
          entry(`${PLATFORM_PREFIX}${LATE_GEN}/manifest.json`, LATER),
          entry(`${PLATFORM_PREFIX}${EARLY_GEN}/manifest.json`, LATER),
        ],
        PLATFORM_PREFIX,
      ),
    ).toBe(LATER_GEN);
  });

  test("a generation with files but no manifest is invisible beside a committed one", () => {
    expect(
      latestCommittedGeneration(
        [
          entry(`${PLATFORM_PREFIX}${LATE_GEN}/manifest.json`),
          // Written later, in key order, and still not readable.
          entry(`${PLATFORM_PREFIX}${LATER_GEN}/files/alpha/1x1.png`),
          entry(`${PLATFORM_PREFIX}${LATER_GEN}/files/beta/1x1.png`),
        ],
        PLATFORM_PREFIX,
      ),
    ).toBe(LATE_GEN);
  });

  test("a malformed generation segment is ignored, and so is another platform's", () => {
    // Each of these is something a hand-written PUT, an older adapter or another
    // writer could leave under this platform. None is a package.
    const noise = [
      "not-a-generation/manifest.json",
      "meta/manifest.json",
      `${String(EARLY).padStart(13, "0")}-staging/manifest.json`,
      `${String(EARLY).padStart(13, "0")}-ABCDEF/manifest.json`,
      "manifest.json",
      "3f1b7a52-0c4d-4a6e-9b21-5d8e7c6a5b4c/manifest.json",
    ];
    for (const suffix of noise) {
      expect(
        latestCommittedGeneration([entry(`${PLATFORM_PREFIX}${suffix}`)], PLATFORM_PREFIX),
      ).toBe(undefined);
    }
    // And another platform's committed generation under THIS platform's prefix is
    // not this one's: a prefix that answered for the namespace would be a prefix
    // that answered for somebody else's package.
    expect(
      latestCommittedGeneration(
        [entry(`${PACKAGES}google-display/${LATER_GEN}/manifest.json`)],
        PLATFORM_PREFIX,
      ),
    ).toBeUndefined();
  });
});

describe("ObjectPackageStore", () => {
  let store: InMemoryObjectStore;

  /** One store, one clock reading, one nonce — so a generation is predictable. */
  const build = (
    target: ObjectStorePort = store,
    over: { at?: number; hex?: string; onSweepError?: (e: unknown, p: string) => void } = {},
  ): ObjectPackageStore =>
    new ObjectPackageStore(target, {
      renderPrefix: RENDERS,
      packagePrefix: PACKAGES,
      campaignSegment: SLUG,
      now: () => over.at ?? EARLY,
      nonce: nonce(over.hex ?? "a"),
      onSweepError: over.onSweepError,
    });

  beforeEach(() => {
    store = new InMemoryObjectStore();
  });

  const keysUnder = (prefix: string) =>
    store.list(prefix).then((entries) => entries.map((e) => e.key).sort());

  test("readAsset returns the render's bytes from the RENDERS prefix", async () => {
    await store.put(`${RENDERS}alpha/1x1.png`, PNG, { contentType: "image/png" });
    expect(
      Buffer.from(await build().readAsset(`${SLUG}/alpha/1x1.png`)).equals(Buffer.from(PNG)),
    ).toBe(true);
    // Never from a package: packaging copies a render, and reading a package back
    // would make a re-package of a re-package possible.
    expect(await store.list(PACKAGES)).toHaveLength(0);
  });

  test("a missing render throws the fs adapter's exact message", async () => {
    // The caller turns this into a 422, so the same absent creative answers the
    // same body on both backends.
    await expect(build().readAsset(`${SLUG}/alpha/never-rendered.png`)).rejects.toThrow(
      `Asset not found: ${SLUG}/alpha/never-rendered.png`,
    );
  });

  test("readAsset refuses a path from another campaign, before any read", async () => {
    await expect(build().readAsset("other-campaign/alpha/1x1.png")).rejects.toThrow(
      /must start with the campaign segment/,
    );
  });

  test("writePackaged round-trips the bytes and the content type to the generation's files/", async () => {
    const packaged = build();
    const logical = await packaged.writePackaged(PLATFORM, `${SLUG}/alpha/1x1.png`, PNG);
    const key = `${PLATFORM_PREFIX}${EARLY_GEN}/files/alpha/1x1.png`;
    const read = await store.get(key);
    expect(Buffer.from(read!.bytes).equals(Buffer.from(PNG))).toBe(true);
    // The type comes from the ONE table in `ObjectExporter`, never a second copy.
    expect(read!.contentType).toBe("image/png");
    // …and it returns a LOGICAL path, never the key: the manifest a customer
    // receives names the fs layout on both backends.
    expect(logical).toBe(`packages/${SLUG}/${PLATFORM}/${SLUG}/alpha/1x1.png`);
    expect(logical).not.toContain(key);
  });

  test("every packaged extension is stored with its own content type", async () => {
    const packaged = build();
    await packaged.writePackaged(PLATFORM, `${SLUG}/alpha/9x16/v0.mp4`, MP4);
    await packaged.writePackaged(PLATFORM, `${SLUG}/alpha/1x1/index.html`, HTML);
    await packaged.writePackaged(PLATFORM, `${SLUG}/alpha/1x1/fallback.png`, PNG);
    const at = (rest: string) =>
      store.get(`${PLATFORM_PREFIX}${EARLY_GEN}/files/${rest}`).then((o) => o!.contentType);
    expect(await at("alpha/9x16/v0.mp4")).toBe("video/mp4");
    expect(await at("alpha/1x1/index.html")).toBe("text/html");
    expect(await at("alpha/1x1/fallback.png")).toBe("image/png");
  });

  test("writePackaged refuses a foreign campaign's path and an unknown extension", async () => {
    const packaged = build();
    await expect(packaged.writePackaged(PLATFORM, "other-camp/alpha/1x1.png", PNG)).rejects.toThrow(
      /must start with the campaign segment/,
    );
    await expect(packaged.writePackaged(PLATFORM, `${SLUG}/alpha/1x1.webp`, PNG)).rejects.toThrow(
      /Refusing to export \.webp/,
    );
    expect(await keysUnder(PACKAGES)).toEqual([]);
  });

  test("one generation per platform, minted once and reused for every file", async () => {
    const packaged = build();
    await packaged.writePackaged(PLATFORM, `${SLUG}/alpha/1x1.png`, PNG);
    await packaged.writePackaged(PLATFORM, `${SLUG}/beta/1x1.png`, PNG);
    // A second platform mints its own: two platforms' files must never interleave
    // in one generation, or one manifest would name the other's bytes.
    await packaged.writePackaged("google-display", `${SLUG}/alpha/300x250.png`, PNG);
    expect(await keysUnder(`${PACKAGES}${PLATFORM}/`)).toEqual([
      `${PLATFORM_PREFIX}${EARLY_GEN}/files/alpha/1x1.png`,
      `${PLATFORM_PREFIX}${EARLY_GEN}/files/beta/1x1.png`,
    ]);
    expect(await keysUnder(`${PACKAGES}google-display/`)).toEqual([
      `${PACKAGES}google-display/${EARLY_GEN}/files/alpha/300x250.png`,
    ]);
  });

  test("the returned paths are the fs adapter's, for the same inputs", async () => {
    const paths = [`${SLUG}/alpha/1x1.png`, `${SLUG}/alpha/9x16/v0.mp4`, `${SLUG}/alpha/i.html`];
    // SEQUENTIAL, as `PackageForPlatformUseCase` drives it. `Promise.all` here
    // would put three concurrent `writePackaged` calls on ONE fs store, and
    // `ensureStaging` is not safe for that: each call sees no staging entry, each
    // sweeps the other's staging dir as stale, and the last `mkdtemp` lands in a
    // tree another call has just removed — the X23 race the fs adapter is built to
    // refuse, provoked by the test rather than by a caller.
    const objectPaths: string[] = [];
    const packaged = build();
    for (const path of paths) objectPaths.push(await packaged.writePackaged(PLATFORM, path, PNG));

    const root = mkdtempSync(join(tmpdir(), "cf-obj-pkg-fs-"));
    try {
      const fsStore = new FileSystemPackageStore(root, SLUG);
      const fsPaths: string[] = [];
      for (const path of paths) fsPaths.push(await fsStore.writePackaged(PLATFORM, path, PNG));
      expect(objectPaths).toEqual(fsPaths);
      // …and the manifest path, which is what the route answers with.
      expect(await build().writeManifest(PLATFORM, manifest({ items: [] }))).toBe(
        await fsStore.writeManifest(PLATFORM, manifest({ items: [] })),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the commit point: files alone are invisible, and the manifest makes them live", async () => {
    const packaged = build();
    await packaged.writePackaged(PLATFORM, `${SLUG}/alpha/1x1.png`, PNG);
    // Before the manifest: a crash mid-write, and a reader sees nothing.
    expect(
      await latestCommittedGeneration(await store.list(PLATFORM_PREFIX), PLATFORM_PREFIX),
    ).toBe(undefined);
    await packaged.writeManifest(PLATFORM, manifest());
    expect(
      await latestCommittedGeneration(await store.list(PLATFORM_PREFIX), PLATFORM_PREFIX),
    ).toBe(EARLY_GEN);
  });

  test("writeManifest writes the manifest byte-identically to the fs file, as application/json", async () => {
    const packaged = build();
    await packaged.writePackaged(PLATFORM, `${SLUG}/alpha/1x1.png`, PNG);
    await packaged.writeManifest(PLATFORM, manifest());
    const objectBytes = await store.get(`${PLATFORM_PREFIX}${EARLY_GEN}/manifest.json`);

    const root = mkdtempSync(join(tmpdir(), "cf-obj-pkg-fs-manifest-"));
    try {
      const fsStore = new FileSystemPackageStore(root, SLUG);
      await fsStore.writePackaged(PLATFORM, `${SLUG}/alpha/1x1.png`, PNG);
      await fsStore.writeManifest(PLATFORM, manifest());
      const fsBytes = readFileSync(resolve(root, "packages", SLUG, PLATFORM, "manifest.json"));
      expect(Buffer.from(objectBytes!.bytes).equals(fsBytes)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    expect(objectBytes!.contentType).toBe("application/json");
  });

  test("a crash mid-write leaves an invisible generation, and the next commit sweeps it", async () => {
    // Request A writes two files and dies before its manifest.
    const a = build();
    await a.writePackaged(PLATFORM, `${SLUG}/alpha/1x1.png`, PNG);
    await a.writePackaged(PLATFORM, `${SLUG}/beta/1x1.png`, PNG);
    expect(
      await latestCommittedGeneration(await store.list(PLATFORM_PREFIX), PLATFORM_PREFIX),
    ).toBe(undefined);

    // Request B, later, commits. A's generation is garbage and goes with it.
    const b = build(store, { at: LATE, hex: "b" });
    await b.writePackaged(PLATFORM, `${SLUG}/alpha/1x1.png`, PNG);
    await b.writeManifest(PLATFORM, manifest());
    expect(
      await latestCommittedGeneration(await store.list(PLATFORM_PREFIX), PLATFORM_PREFIX),
    ).toBe(LATE_GEN);
    expect(await keysUnder(PLATFORM_PREFIX)).toEqual([
      `${PLATFORM_PREFIX}${LATE_GEN}/files/alpha/1x1.png`,
      `${PLATFORM_PREFIX}${LATE_GEN}/manifest.json`,
    ]);
  });

  test("X23: a generation swept by another writer stops at the claim check, and commits nothing", async () => {
    // A prior, legitimate commit is live.
    const prior = build(store, { at: EARLY, hex: "a" });
    await prior.writePackaged(PLATFORM, `${SLUG}/alpha/old.png`, PNG);
    await prior.writeManifest(
      PLATFORM,
      manifest({
        items: [
          manifestItem({ packagedPath: `packages/${SLUG}/${PLATFORM}/${SLUG}/alpha/old.png` }),
        ],
      }),
    );

    // Request B writes its own generation…
    const b = build(store, { at: LATE, hex: "b" });
    await b.writePackaged(PLATFORM, `${SLUG}/alpha/1x1.png`, PNG);
    // …and request C, later still, commits and sweeps B's generation wholesale.
    const c = build(store, { at: LATER, hex: "c" });
    await c.writePackaged(PLATFORM, `${SLUG}/alpha/new.png`, PNG);
    await c.writeManifest(
      PLATFORM,
      manifest({
        items: [
          manifestItem({ packagedPath: `packages/${SLUG}/${PLATFORM}/${SLUG}/alpha/new.png` }),
        ],
      }),
    );

    // B now finds its own keys gone, and refuses rather than committing a manifest
    // naming files that are not there. The message is the fs adapter's own, so a
    // caller cannot tell which backend it is on.
    await expect(b.writeManifest(PLATFORM, manifest())).rejects.toThrow(
      "Another export of this campaign started while this one was running",
    );
    // Nothing of B's was committed, and C's package is untouched.
    expect(
      await latestCommittedGeneration(await store.list(PLATFORM_PREFIX), PLATFORM_PREFIX),
    ).toBe(LATER_GEN);
    expect(await keysUnder(`${PLATFORM_PREFIX}${LATER_GEN}/`)).toEqual([
      `${PLATFORM_PREFIX}${LATER_GEN}/files/alpha/new.png`,
      `${PLATFORM_PREFIX}${LATER_GEN}/manifest.json`,
    ]);
  });

  test("X23: a claimed path outside this platform's own prefix is refused as an interruption", async () => {
    const packaged = build();
    await packaged.writePackaged(PLATFORM, `${SLUG}/alpha/1x1.png`, PNG);
    // A path rooted at another platform can never be in this generation.
    await expect(
      packaged.writeManifest(
        PLATFORM,
        manifest({
          items: [manifestItem({ packagedPath: `packages/${SLUG}/linkedin/alpha/1x1.png` })],
        }),
      ),
    ).rejects.toThrow(/^Another export of this campaign/);
    // And one that cannot be a key at all — a traversal out of the generation.
    await expect(
      packaged.writeManifest(
        PLATFORM,
        manifest({
          items: [manifestItem({ packagedPath: `packages/${SLUG}/${PLATFORM}/../../escape.png` })],
        }),
      ),
    ).rejects.toThrow(/^Another export of this campaign/);
    expect(
      await latestCommittedGeneration(await store.list(PLATFORM_PREFIX), PLATFORM_PREFIX),
    ).toBe(undefined);
  });

  test("X23: a motion poster and an html fallback are claimed too, and a missing one stops the commit", async () => {
    const packaged = build();
    const one = await packaged.writePackaged(PLATFORM, `${SLUG}/alpha/9x16/v0.mp4`, MP4);
    const two = await packaged.writePackaged(PLATFORM, `${SLUG}/alpha/9x16/v0.png`, PNG);
    // The poster exists; the fallback does not.
    await expect(
      packaged.writeManifest(
        PLATFORM,
        manifest({
          items: [
            manifestItem({
              format: "motion",
              packagedPath: one,
              posterPath: two,
              fallbackPath: `packages/${SLUG}/${PLATFORM}/${SLUG}/alpha/9x16/fallback.png`,
            }),
          ],
        }),
      ),
    ).rejects.toThrow(/^Another export of this campaign/);
    // With the fallback written, the same manifest commits.
    const three = await packaged.writePackaged(PLATFORM, `${SLUG}/alpha/9x16/fallback.png`, PNG);
    await packaged.writeManifest(
      PLATFORM,
      manifest({
        items: [
          manifestItem({
            format: "motion",
            packagedPath: one,
            posterPath: two,
            fallbackPath: three,
          }),
        ],
      }),
    );
    expect(
      await latestCommittedGeneration(await store.list(PLATFORM_PREFIX), PLATFORM_PREFIX),
    ).toBe(EARLY_GEN);
  });

  test("the sweep empties every OLDER generation, committed or not", async () => {
    // Three generations of history, only the middle one committed.
    for (const [at, hex] of [
      [EARLY, "a"],
      [LATE, "b"],
      [LATER, "c"],
    ] as const) {
      await store.put(`${PLATFORM_PREFIX}${gen(at, hex)}/files/alpha/1x1.png`, PNG);
    }
    await store.put(`${PLATFORM_PREFIX}${LATE_GEN}/manifest.json`, new Uint8Array([1]));

    // A commit strictly newer than all three empties the two older ones.
    const newest = build(store, { at: LATER + 5_000, hex: "d" });
    await newest.writePackaged(PLATFORM, `${SLUG}/alpha/1x1.png`, PNG);
    await newest.writeManifest(PLATFORM, manifest());
    expect(await keysUnder(PLATFORM_PREFIX)).toEqual([
      `${PLATFORM_PREFIX}${gen(LATER + 5_000, "d")}/files/alpha/1x1.png`,
      `${PLATFORM_PREFIX}${gen(LATER + 5_000, "d")}/manifest.json`,
    ]);
  });

  test("the sweep NEVER empties a generation that sorts after this one: an in-flight writer keeps its files", async () => {
    // **REFRAMED under the monotonic floor (fix round 1, item 2).** The old version
    // put the in-flight generation in the store BEFORE the committing writer minted
    // its own, which the floor now makes LATER — so this writer legitimately
    // supersedes it, and the assertion that it survived was asserting a property
    // item 2 gives up on purpose.
    //
    // "Newer" now means "minted later, floor-adjusted", and the floor is computed
    // from what this writer could SEE at mint time. The generation a sweep must
    // never touch is therefore the one that appears AFTER the mint: another
    // request, writing right now, which no listing this writer has taken can
    // contain. That is the case a `<=` comparison would delete, and the case the
    // strict `<` exists for.
    const committing = build(store, { at: LATE, hex: "b" });
    await committing.writePackaged(PLATFORM, `${SLUG}/alpha/1x1.png`, PNG);
    // Arrives after the mint above: a second request's generation, in flight.
    await store.put(`${PLATFORM_PREFIX}${LATER_GEN}/files/alpha/inflight.png`, PNG);

    await committing.writeManifest(PLATFORM, manifest());

    expect(
      await store.get(`${PLATFORM_PREFIX}${LATER_GEN}/files/alpha/inflight.png`),
    ).toBeDefined();
    // …and this writer's own commit is still the live one, because the in-flight
    // generation has no manifest to be live with.
    expect(
      await latestCommittedGeneration(await store.list(PLATFORM_PREFIX), PLATFORM_PREFIX),
    ).toBe(LATE_GEN);
  });

  test("a key under the platform prefix that is not a generation survives the sweep", async () => {
    // Another writer's directory, or a hand-written PUT. This adapter has no
    // business reading it as a package, and none at all emptying it.
    const foreign = `${PLATFORM_PREFIX}incoming-uploads/alpha/1x1.png`;
    await store.put(foreign, PNG);
    await store.put(`${PLATFORM_PREFIX}${EARLY_GEN}/files/alpha/1x1.png`, PNG);

    const packaged = build(store, { at: LATE, hex: "b" });
    await packaged.writePackaged(PLATFORM, `${SLUG}/alpha/1x1.png`, PNG);
    await packaged.writeManifest(PLATFORM, manifest());
    expect(await store.get(foreign)).toBeDefined();
  });

  test("a cleanup that FAILS still reports success, with the package committed", async () => {
    const broken = storeWithBrokenCleanup(store);
    await store.put(`${PLATFORM_PREFIX}${EARLY_GEN}/files/alpha/1x1.png`, PNG);

    const packaged = build(broken, { at: LATE, hex: "b" });
    await packaged.writePackaged(PLATFORM, `${SLUG}/alpha/1x1.png`, PNG);
    // The commit happened before the sweep, so a refusal from the bucket is
    // garbage collection failing — not an export that did not finish. The next
    // commit sweeps the same generations anyway.
    await expect(packaged.writeManifest(PLATFORM, manifest())).resolves.toBe(
      `packages/${SLUG}/${PLATFORM}/manifest.json`,
    );
    expect(
      await latestCommittedGeneration(await store.list(PLATFORM_PREFIX), PLATFORM_PREFIX),
    ).toBe(LATE_GEN);
    // And the older generation is still there, to be swept next time.
    expect(await store.get(`${PLATFORM_PREFIX}${EARLY_GEN}/files/alpha/1x1.png`)).toBeDefined();
  });

  test("a failed sweep is REPORTED: the callback receives the error and the platform", async () => {
    // A silent catch is its own defect: the generations accumulate and the only
    // symptom an operator ever sees is a bucket quietly out of space. So the
    // failure crosses the port boundary as an argument, not as a throw.
    const reported: Array<{ error: unknown; platformId: string }> = [];
    const broken = storeWithBrokenCleanup(store);
    await store.put(`${PLATFORM_PREFIX}${EARLY_GEN}/files/alpha/1x1.png`, PNG);

    const packaged = build(broken, {
      at: LATE,
      hex: "b",
      onSweepError: (error, platformId) => reported.push({ error, platformId }),
    });
    await packaged.writePackaged(PLATFORM, `${SLUG}/alpha/1x1.png`, PNG);
    await packaged.writeManifest(PLATFORM, manifest());

    expect(reported).toHaveLength(1);
    expect(reported[0]!.platformId).toBe(PLATFORM);
    // The very error the store raised, not a rewritten one: a caller that wants to
    // branch on a status code or a code has to be able to.
    expect((reported[0]!.error as Error).message).toMatch(/refused the sweep/);
    // Still exactly one commit, and the older generation still standing.
    expect(
      await latestCommittedGeneration(await store.list(PLATFORM_PREFIX), PLATFORM_PREFIX),
    ).toBe(LATE_GEN);
    expect(await store.get(`${PLATFORM_PREFIX}${EARLY_GEN}/files/alpha/1x1.png`)).toBeDefined();
  });

  test("a sweep callback that ITSELF throws still leaves the committed package live", async () => {
    // The reporting is wrapped, and this is why: a logger that cannot open its
    // transport, a buffer that is full, a callback with a bug — none of those may
    // turn garbage collection into a failed export, which is the exact thing the
    // swallow around the sweep exists to prevent.
    const broken = storeWithBrokenCleanup(store);
    await store.put(`${PLATFORM_PREFIX}${EARLY_GEN}/files/alpha/1x1.png`, PNG);

    const packaged = build(broken, {
      at: LATE,
      hex: "b",
      onSweepError: () => {
        throw new Error("the logger could not open its transport");
      },
    });
    await packaged.writePackaged(PLATFORM, `${SLUG}/alpha/1x1.png`, PNG);
    await expect(packaged.writeManifest(PLATFORM, manifest())).resolves.toBe(
      `packages/${SLUG}/${PLATFORM}/manifest.json`,
    );
    expect(
      await latestCommittedGeneration(await store.list(PLATFORM_PREFIX), PLATFORM_PREFIX),
    ).toBe(LATE_GEN);
  });

  test("a sweep that works reports NOTHING: no callback, no phantom error", async () => {
    // The other direction, and the one a bare `catch {}` cannot get right: with
    // nothing to report, the callback must not fire. A store that is merely being
    // asked to delete nothing is not a failure.
    let calls = 0;
    const packaged = build(store, {
      at: LATE,
      hex: "b",
      onSweepError: () => {
        calls += 1;
      },
    });
    await packaged.writePackaged(PLATFORM, `${SLUG}/alpha/1x1.png`, PNG);
    await packaged.writeManifest(PLATFORM, manifest());
    expect(calls).toBe(0);
  });

  test("newest wins: a generation minted LAST is the one readers get, clock or no clock", async () => {
    // The second export commits FIRST, and its writer's clock reads EARLIER than
    // the first's — a replica behind, or two pods with unsynced clocks. The
    // guarantee is "the most recently MINTED generation wins", not "the latest
    // wall-clock stamp wins", because readers order by the stamp and a clock
    // disagreement would otherwise leave the newer export permanently in the
    // shadow of the older one: written, committed, and never read by anything.
    const first = build(store, { at: EARLY, hex: "a" });
    await first.writePackaged(PLATFORM, `${SLUG}/alpha/old.png`, PNG);
    await first.writeManifest(
      PLATFORM,
      manifest({
        items: [
          manifestItem({ packagedPath: `packages/${SLUG}/${PLATFORM}/${SLUG}/alpha/old.png` }),
        ],
      }),
    );

    const second = build(store, { at: EARLY - 60_000, hex: "b" });
    await second.writePackaged(PLATFORM, `${SLUG}/alpha/new.png`, PNG);
    await second.writeManifest(
      PLATFORM,
      manifest({
        items: [
          manifestItem({ packagedPath: `packages/${SLUG}/${PLATFORM}/${SLUG}/alpha/new.png` }),
        ],
      }),
    );

    // It is live, and the generation it replaced is gone.
    expect(
      await latestCommittedGeneration(await store.list(PLATFORM_PREFIX), PLATFORM_PREFIX),
    ).toBe(gen(EARLY + 1, "b"));
    expect(await store.get(`${PLATFORM_PREFIX}${EARLY_GEN}/files/alpha/old.png`)).toBeUndefined();
  });

  test("a lagging replica's re-export still becomes the live one, and supersedes what it can see", async () => {
    // The case item 2 exists for, stated as one question: an existing COMMITTED
    // generation at stamp T, and a writer whose `now()` reads a full minute
    // BEFORE T. Before the floor, that writer minted `T - 60_000`, its manifest
    // committed, and `latestCommittedGeneration` kept answering with the older
    // package — a re-export that nobody could ever read.
    await store.put(`${PLATFORM_PREFIX}${EARLY_GEN}/files/alpha/1x1.png`, PNG);
    await store.put(`${PLATFORM_PREFIX}${EARLY_GEN}/manifest.json`, new Uint8Array([1]));
    expect(
      await latestCommittedGeneration(await store.list(PLATFORM_PREFIX), PLATFORM_PREFIX),
    ).toBe(EARLY_GEN);

    const lagging = build(store, { at: EARLY - 60_000, hex: "d" });
    await lagging.writePackaged(PLATFORM, `${SLUG}/alpha/1x1.png`, PNG);
    await lagging.writeManifest(PLATFORM, manifest());

    // Sorted AFTER T, not before it — which is the whole of the floor's purpose.
    expect(gen(EARLY + 1, "d") > EARLY_GEN).toBe(true);
    expect(
      await latestCommittedGeneration(await store.list(PLATFORM_PREFIX), PLATFORM_PREFIX),
    ).toBe(gen(EARLY + 1, "d"));
    // And its commit swept the generation it superseded, so the platform holds one.
    expect(await keysUnder(PLATFORM_PREFIX)).toEqual([
      `${PLATFORM_PREFIX}${gen(EARLY + 1, "d")}/files/alpha/1x1.png`,
      `${PLATFORM_PREFIX}${gen(EARLY + 1, "d")}/manifest.json`,
    ]);
  });

  test("with nothing to compare against the stamp is the clock, unchanged", async () => {
    // The floor must not invent a future. A fresh platform's first generation is
    // exactly what the clock said, or every key in the namespace would be stamped
    // ahead of wall time and a later reader comparing the two would be misled.
    const packaged = build(store, { at: EARLY, hex: "a" });
    await packaged.writePackaged(PLATFORM, `${SLUG}/alpha/1x1.png`, PNG);
    expect(await keysUnder(PLATFORM_PREFIX)).toEqual([
      `${PLATFORM_PREFIX}${EARLY_GEN}/files/alpha/1x1.png`,
    ]);
  });

  test("an uncommitted generation raises the floor too, and a malformed one does not", async () => {
    // Committed or not: a crashed writer's generation is still a generation, and
    // re-minting its stamp under a later clock would put two writers' bytes under
    // one segment.
    await store.put(`${PLATFORM_PREFIX}${LATER_GEN}/files/alpha/1x1.png`, PNG);
    const afterCrash = build(store, { at: EARLY, hex: "b" });
    await afterCrash.writePackaged(PLATFORM, `${SLUG}/alpha/1x1.png`, PNG);
    expect(await keysUnder(PLATFORM_PREFIX)).toContain(
      `${PLATFORM_PREFIX}${gen(LATER + 1, "b")}/files/alpha/1x1.png`,
    );

    // A malformed segment is ignored for the floor exactly as readers ignore it —
    // and this is not academic. Its leading digits are a huge NUMBER, so a floor
    // computed from it would be past 13 digits, `padStart` would not shorten it,
    // and every generation minted afterwards would fail `PACKAGE_GENERATION_PATTERN`
    // and be invisible forever.
    await store.put(`${PLATFORM_PREFIX}${"9".repeat(20)}-${"e".repeat(32)}/manifest.json`, PNG);
    await store.put(`${PLATFORM_PREFIX}${"9".repeat(13)}.staging-x/manifest.json`, PNG);
    const afterNoise = build(store, { at: EARLY, hex: "c" });
    await afterNoise.writePackaged(PLATFORM, `${SLUG}/alpha/1x1.png`, PNG);
    // Still a 13-digit stamp read from the clock, not a 20-digit one.
    expect(await keysUnder(PLATFORM_PREFIX)).toContain(
      `${PLATFORM_PREFIX}${gen(LATER + 2, "c")}/files/alpha/1x1.png`,
    );
  });

  test("a manifest committed after a newer writer swept its generation is never read, and the next commit removes it", async () => {
    // The window the claim check cannot close, pinned rather than argued about.
    // A passes its claim check; B (newer) commits and sweeps A's generation; A
    // then writes its manifest. A's package is committed and complete-looking,
    // and it is NOT what any reader gets, because B's generation sorts after it.
    // Nothing is corrupted: readers take the newest committed generation, and the
    // next commit for this platform sweeps A's.
    const a = build(store, { at: EARLY, hex: "a" });
    await a.writePackaged(PLATFORM, `${SLUG}/alpha/a.png`, PNG);
    await a.writeManifest(
      PLATFORM,
      manifest({
        items: [manifestItem({ packagedPath: `packages/${SLUG}/${PLATFORM}/${SLUG}/alpha/a.png` })],
      }),
    );

    // B commits later, and sweeps A wholesale.
    const b = build(store, { at: LATE, hex: "b" });
    await b.writePackaged(PLATFORM, `${SLUG}/alpha/b.png`, PNG);
    await b.writeManifest(
      PLATFORM,
      manifest({
        items: [manifestItem({ packagedPath: `packages/${SLUG}/${PLATFORM}/${SLUG}/alpha/b.png` })],
      }),
    );
    expect(await store.get(`${PLATFORM_PREFIX}${EARLY_GEN}/manifest.json`)).toBeUndefined();

    // A's manifest PUT lands now, into the generation B already swept — what a
    // commit between A's claim check and A's PUT leaves behind: a manifest whose
    // files are gone. Readers still get B's generation.
    await store.put(`${PLATFORM_PREFIX}${EARLY_GEN}/manifest.json`, new Uint8Array([1]));
    expect(
      await latestCommittedGeneration(await store.list(PLATFORM_PREFIX), PLATFORM_PREFIX),
    ).toBe(LATE_GEN);

    // A later commit for the platform removes it.
    const c = build(store, { at: LATER, hex: "c" });
    await c.writePackaged(PLATFORM, `${SLUG}/alpha/c.png`, PNG);
    await c.writeManifest(PLATFORM, manifest({ items: [] }));
    expect(await store.get(`${PLATFORM_PREFIX}${EARLY_GEN}/manifest.json`)).toBeUndefined();
    expect(await store.get(`${PLATFORM_PREFIX}${LATE_GEN}/manifest.json`)).toBeUndefined();
    expect(
      await latestCommittedGeneration(await store.list(PLATFORM_PREFIX), PLATFORM_PREFIX),
    ).toBe(gen(LATER, "c"));
  });

  test("pagination: the claim check and the sweep see every page", async () => {
    // Two keys per page, with three files in this generation and three older
    // generations below it — so the claim check must read past the first page to
    // find the third file, and the sweep past the first page to find the third
    // generation. A `list` that read one page would pass every other test here.
    const paged = new InMemoryObjectStore({ listPageSize: 2 });
    for (const [at, hex] of [
      [EARLY, "a"],
      [LATE, "b"],
      [LATER, "c"],
    ] as const) {
      await paged.put(`${PLATFORM_PREFIX}${gen(at, hex)}/files/alpha/1x1.png`, PNG);
    }
    await paged.put(`${PLATFORM_PREFIX}${EARLY_GEN}/manifest.json`, new Uint8Array([1]));

    const packaged = new ObjectPackageStore(paged, {
      renderPrefix: RENDERS,
      packagePrefix: PACKAGES,
      campaignSegment: SLUG,
      now: () => LATER + 5_000,
      nonce: nonce("d"),
    });
    const one = await packaged.writePackaged(PLATFORM, `${SLUG}/alpha/1x1.png`, PNG);
    const two = await packaged.writePackaged(PLATFORM, `${SLUG}/beta/1x1.png`, PNG);
    const three = await packaged.writePackaged(PLATFORM, `${SLUG}/gamma/1x1.png`, PNG);
    await packaged.writeManifest(
      PLATFORM,
      manifest({
        items: [
          manifestItem({ packagedPath: one }),
          manifestItem({ packagedPath: two }),
          manifestItem({ packagedPath: three }),
        ],
      }),
    );

    const newest = `${PLATFORM_PREFIX}${gen(LATER + 5_000, "d")}`;
    expect((await paged.list(PLATFORM_PREFIX)).map((e) => e.key).sort()).toEqual([
      `${newest}/files/alpha/1x1.png`,
      `${newest}/files/beta/1x1.png`,
      `${newest}/files/gamma/1x1.png`,
      `${newest}/manifest.json`,
    ]);
  });

  test("pagination: a claimed file that exists ONLY on the last page is still found", async () => {
    // The previous version of this test claimed a file that was never written,
    // which the claim check rejects from the FIRST page — so it passed against an
    // implementation that read one page and proved nothing about pagination. This
    // one claims a file that EXISTS, and puts it where a one-page read cannot see
    // it: three files at two keys per page, and the claimed one is last.
    const paged = new InMemoryObjectStore({ listPageSize: 2 });
    const packaged = new ObjectPackageStore(paged, {
      renderPrefix: RENDERS,
      packagePrefix: PACKAGES,
      campaignSegment: SLUG,
      now: () => EARLY,
      nonce: nonce("a"),
    });
    const one = await packaged.writePackaged(PLATFORM, `${SLUG}/alpha/1x1.png`, PNG);
    const two = await packaged.writePackaged(PLATFORM, `${SLUG}/beta/1x1.png`, PNG);
    const three = await packaged.writePackaged(PLATFORM, `${SLUG}/gamma/1x1.png`, PNG);
    // Sanity: the file really is there, really is last, and a two-key read misses
    // it. Without this the test would be asserting nothing about the page it names.
    const all = await paged.list(`${PLATFORM_PREFIX}${EARLY_GEN}/files/`);
    expect(all).toHaveLength(3);
    expect(all.map((e) => e.key)).toContain(`${PLATFORM_PREFIX}${EARLY_GEN}/files/gamma/1x1.png`);
    expect(
      (await paged.list(`${PLATFORM_PREFIX}${EARLY_GEN}/files/`)).slice(0, 2).map((e) => e.key),
    ).not.toContain(`${PLATFORM_PREFIX}${EARLY_GEN}/files/gamma/1x1.png`);

    // The commit SUCCEEDS, and only because the claim check read past the first
    // page: the manifest's third item names a key the first page does not hold.
    await expect(
      packaged.writeManifest(
        PLATFORM,
        manifest({
          items: [
            manifestItem({ packagedPath: one }),
            manifestItem({ packagedPath: two }),
            manifestItem({ packagedPath: three }),
          ],
        }),
      ),
    ).resolves.toBe(`packages/${SLUG}/${PLATFORM}/manifest.json`);
    expect(
      await latestCommittedGeneration(await paged.list(PLATFORM_PREFIX), PLATFORM_PREFIX),
    ).toBe(EARLY_GEN);
  });

  test("cross-tenant: a store built for one org writes only under that org", async () => {
    // The prefix is the ONLY thing separating two tenants, and a campaign's uuid
    // is not globally unique, so this is the case a key builder without `org_id`
    // answers wrongly.
    const otherPrefix = `org/globex/campaign/${OTHER_CAMPAIGN}/packages/`;
    const otherPlatformPrefix = `${otherPrefix}${PLATFORM}/`;
    const other = new ObjectPackageStore(store, {
      renderPrefix: `org/globex/campaign/${OTHER_CAMPAIGN}/renders/`,
      packagePrefix: otherPrefix,
      campaignSegment: SLUG,
      now: () => EARLY,
      nonce: nonce("a"),
    });
    const mine = build();
    await mine.writePackaged(PLATFORM, `${SLUG}/alpha/1x1.png`, PNG);
    await other.writePackaged(PLATFORM, `${SLUG}/alpha/1x1.png`, PNG);

    expect(await keysUnder(PLATFORM_PREFIX)).toEqual([
      `${PLATFORM_PREFIX}${EARLY_GEN}/files/alpha/1x1.png`,
    ]);
    expect(await keysUnder(otherPrefix)).toEqual([
      `${otherPlatformPrefix}${EARLY_GEN}/files/alpha/1x1.png`,
    ]);
    // And one org's sweep leaves the other alone: the ids partition the deletions.
    await mine.writeManifest(PLATFORM, manifest());
    expect(await keysUnder(otherPrefix)).toEqual([
      `${otherPlatformPrefix}${EARLY_GEN}/files/alpha/1x1.png`,
    ]);
  });

  test("a platform id that cannot be a key segment is refused before anything is written", async () => {
    await expect(build().writePackaged("../escape", `${SLUG}/alpha/1x1.png`, PNG)).rejects.toThrow(
      /^Refusing an object key: the platform id/,
    );
    await expect(build().writeManifest("", manifest({ platformId: "" }))).rejects.toThrow(
      /^Refusing an object key: the platform id/,
    );
    expect(await keysUnder(PACKAGES)).toEqual([]);
  });

  test("DoD 3: after a FULL package, no key in the store carries the slug", async () => {
    // Driven through the real use case, so the paths are the ones a run produces:
    // a classic still, a motion clip and its poster, an html bundle and its
    // raster fallback, across three platforms.
    const assets: GeneratedAsset[] = [
      {
        productId: "alpha",
        aspectRatio: "1:1",
        outputPath: `${SLUG}/alpha/1x1.png`,
        complianceScore: 0.5,
        passedCompliance: true,
        logoApplied: true,
        treatment: "default",
        backgroundSource: "procedural",
      },
      {
        productId: "alpha",
        aspectRatio: "9:16",
        outputPath: `${SLUG}/alpha/9x16/v0.png`,
        videoPath: `${SLUG}/alpha/9x16/v0.mp4`,
        format: "motion",
        durationSec: 12,
        complianceScore: 0.5,
        passedCompliance: true,
        logoApplied: true,
        treatment: "default",
        backgroundSource: "procedural",
      },
      {
        productId: "alpha",
        size: "300x250",
        outputPath: `${SLUG}/alpha/300x250/fallback.png`,
        htmlBundlePath: `${SLUG}/alpha/300x250/index.html`,
        htmlFallbackPath: `${SLUG}/alpha/300x250/fallback.png`,
        format: "html",
        complianceScore: 0.5,
        passedCompliance: true,
        logoApplied: true,
        treatment: "default",
        backgroundSource: "procedural",
      },
    ];
    for (const [path, bytes] of [
      [`${SLUG}/alpha/1x1.png`, PNG],
      [`${SLUG}/alpha/9x16/v0.png`, PNG],
      [`${SLUG}/alpha/9x16/v0.mp4`, MP4],
      [`${SLUG}/alpha/300x250/fallback.png`, PNG],
      [`${SLUG}/alpha/300x250/index.html`, HTML],
    ] as const) {
      await store.put(`${RENDERS}${path.slice(SLUG.length + 1)}`, bytes);
    }

    const result = await new PackageForPlatformUseCase(build()).execute({
      campaignId: SLUG,
      assets,
      platforms: ["instagram-feed", "instagram-reel", "google-display-html"],
      packagedAt: "2026-08-25T12:00:00.000Z",
      skipped: 0,
      capabilities: { motion: true },
    });
    expect(result.success).toBe(true);

    const written = await keysUnder(PACKAGES);
    expect(written.length).toBeGreaterThan(0);
    for (const key of written) {
      expect(key).not.toContain(SLUG);
      expect(key.startsWith(PACKAGES)).toBe(true);
    }
    // And every manifest names logical paths, so the slug appears in the customer's
    // own file layout and nowhere in the store's namespace.
    for (const key of written.filter((k) => k.endsWith("manifest.json"))) {
      const parsed = JSON.parse(
        Buffer.from((await store.get(key))!.bytes).toString("utf8"),
      ) as PackageManifest;
      for (const item of parsed.items) {
        for (const path of [item.packagedPath, item.posterPath, item.fallbackPath]) {
          if (path === undefined) continue;
          expect(path.startsWith(`packages/${SLUG}/${item.packagedPath.split("/")[2]}/`)).toBe(
            true,
          );
        }
      }
    }
  });
});
