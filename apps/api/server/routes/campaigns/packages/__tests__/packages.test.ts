import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { crc32 } from "node:zlib";
import { createApp, createRouter, toWebHandler, type EventHandler } from "h3";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
  type CampaignBrief,
} from "@campaignfoundry/CampaignOrchestration";
import listHandler from "../[campaignId].get.js";
import zipHandler from "../[campaignId]/[platformZip].get.js";
import { Readable } from "node:stream";
import { measure, storeZipStream } from "../store-zip.js";
import { getBriefStore } from "../../../../lib/ports/index.js";
import { LOCAL_TENANT } from "../../../../lib/tenant.js";
import { setupPgHarness, type PgHarness } from "../../../__tests__/tenant-harness.js";
// Lifted for `packages.s3.test.ts` (PT-4h2): both backends' zips are read by ONE
// parser, so "the zip over objects is the fs zip" is checkable rather than assumed.
import { parseCentralDirectory } from "./central-directory.js";

// node:fs/promises is an ESM namespace (not spy-able); route the walk's readdir
// through an overridable hook so a mid-walk ENOENT / EACCES can be simulated.
const fsHook = vi.hoisted(() => ({
  readdir: undefined as undefined | ((path: string) => Promise<never>),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: (path: string, options?: unknown) =>
      fsHook.readdir
        ? fsHook.readdir(path)
        : (actual.readdir as (p: string, o?: unknown) => Promise<unknown>)(path, options),
  };
});

const web = (method: "get", path: string, handler: EventHandler) => {
  const app = createApp();
  const router = createRouter();
  router.get(path, handler);
  app.use(router);
  return toWebHandler(app);
};

const listCall = (campaignId: string) =>
  web(
    "get",
    "/campaigns/packages/:campaignId",
    listHandler,
  )(new Request(`http://x/campaigns/packages/${campaignId}`));

const zipCall = (campaignId: string, platformZip: string) =>
  web(
    "get",
    "/campaigns/packages/:campaignId/:platformZip",
    zipHandler,
  )(new Request(`http://x/campaigns/packages/${campaignId}/${platformZip}`));

let dir: string;
const origOut = process.env.OUTPUT_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cf-packages-"));
  process.env.OUTPUT_DIR = dir;
});
afterEach(() => {
  fsHook.readdir = undefined;
  rmSync(dir, { recursive: true, force: true });
  if (origOut === undefined) delete process.env.OUTPUT_DIR;
  else process.env.OUTPUT_DIR = origOut;
});

const manifest = (platformId: string) => ({
  campaignId: "camp",
  platformId,
  packagedAt: "2026-01-01T00:00:00.000Z",
  skipped: 0,
  items: [{ productId: "alpha", checks: { size: "pass" } }],
});

describe("GET /campaigns/packages/:campaignId", () => {
  test("lists manifests under the campaign package dir", async () => {
    mkdirSync(resolve(dir, "packages/camp/instagram-feed"), { recursive: true });
    mkdirSync(resolve(dir, "packages/camp/x"), { recursive: true });
    writeFileSync(
      resolve(dir, "packages/camp/instagram-feed/manifest.json"),
      JSON.stringify(manifest("instagram-feed")),
    );
    writeFileSync(resolve(dir, "packages/camp/x/manifest.json"), JSON.stringify(manifest("x")));
    const res = await listCall("camp");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { platforms: Array<{ platformId: string }> };
    expect(body.platforms.map((p) => p.platformId)).toEqual(["instagram-feed", "x"]);
  });

  test("returns 404 when the campaign has no packages", async () => {
    const res = await listCall("camp");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "No packages found" });
  });

  test("returns 400 for an unsafe campaign id", async () => {
    const res = await listCall("Not_Valid");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid campaign id" });
  });

  test("returns 404 when the campaign path is a file", async () => {
    mkdirSync(resolve(dir, "packages"), { recursive: true });
    writeFileSync(resolve(dir, "packages/camp"), "not-a-dir");
    const res = await listCall("camp");
    expect(res.status).toBe(404);
  });

  test("skips non-dirs, unsafe names, invalid JSON, and missing manifests", async () => {
    mkdirSync(resolve(dir, "packages/camp/instagram-feed"), { recursive: true });
    mkdirSync(resolve(dir, "packages/camp/NotValid"), { recursive: true });
    mkdirSync(resolve(dir, "packages/camp/empty"), { recursive: true });
    mkdirSync(resolve(dir, "packages/camp/badjson"), { recursive: true });
    mkdirSync(resolve(dir, "packages/camp/arrayjson"), { recursive: true });
    mkdirSync(resolve(dir, "packages/camp/nulljson"), { recursive: true });
    writeFileSync(resolve(dir, "packages/camp/note.txt"), "hi");
    writeFileSync(
      resolve(dir, "packages/camp/instagram-feed/manifest.json"),
      JSON.stringify(manifest("instagram-feed")),
    );
    writeFileSync(resolve(dir, "packages/camp/badjson/manifest.json"), "{");
    writeFileSync(resolve(dir, "packages/camp/arrayjson/manifest.json"), "[]");
    writeFileSync(resolve(dir, "packages/camp/nulljson/manifest.json"), "null");
    const res = await listCall("camp");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { platforms: Array<{ platformId: string }> };
    expect(body.platforms).toHaveLength(1);
    expect(body.platforms[0].platformId).toBe("instagram-feed");
  });

  test("returns 404 when every platform folder is skipped", async () => {
    mkdirSync(resolve(dir, "packages/camp/empty"), { recursive: true });
    const res = await listCall("camp");
    expect(res.status).toBe(404);
  });

  test("returns 404 when the campaign dir is a symlink pointing outside the output root", async () => {
    const outside = mkdtempSync(join(tmpdir(), "cf-pkg-outside-"));
    try {
      mkdirSync(join(outside, "instagram-feed"), { recursive: true });
      writeFileSync(
        join(outside, "instagram-feed/manifest.json"),
        JSON.stringify(manifest("leaked")),
      );
      mkdirSync(resolve(dir, "packages"), { recursive: true });
      symlinkSync(outside, resolve(dir, "packages/camp"));
      const res = await listCall("camp");
      expect(res.status).toBe(404);
      const body = await res.text();
      expect(JSON.parse(body)).toEqual({ error: "No packages found" });
      expect(body).not.toContain("leaked");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("still lists a manifest that is a symlink staying inside the campaign dir", async () => {
    mkdirSync(resolve(dir, "packages/camp/instagram-feed"), { recursive: true });
    mkdirSync(resolve(dir, "packages/camp/meta-feed"), { recursive: true });
    writeFileSync(
      resolve(dir, "packages/camp/instagram-feed/manifest.json"),
      JSON.stringify(manifest("instagram-feed")),
    );
    writeFileSync(
      resolve(dir, "packages/camp/meta-manifest.json"),
      JSON.stringify(manifest("meta-feed")),
    );
    symlinkSync(
      resolve(dir, "packages/camp/meta-manifest.json"),
      resolve(dir, "packages/camp/meta-feed/manifest.json"),
    );
    const res = await listCall("camp");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { platforms: Array<{ platformId: string }> };
    expect(body.platforms.map((p) => p.platformId)).toEqual(["instagram-feed", "meta-feed"]);
  });
});

describe("GET /campaigns/packages/:campaignId/:platformId.zip", () => {
  test("streams a store-only zip whose central directory matches the files", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const manifestJson = JSON.stringify(manifest("instagram-feed"));
    mkdirSync(resolve(dir, "packages/camp/instagram-feed/alpha"), { recursive: true });
    writeFileSync(resolve(dir, "packages/camp/instagram-feed/manifest.json"), manifestJson);
    writeFileSync(resolve(dir, "packages/camp/instagram-feed/alpha/1x1.png"), png);
    symlinkSync(
      resolve(dir, "packages/camp/instagram-feed/manifest.json"),
      resolve(dir, "packages/camp/instagram-feed/link"),
    );
    const res = await zipCall("camp", "instagram-feed.zip");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/zip/);
    const buf = Buffer.from(await res.arrayBuffer());
    const files = parseCentralDirectory(buf);
    expect(files.map((f) => f.name).sort()).toEqual(["alpha/1x1.png", "manifest.json"]);
    const pngEntry = files.find((f) => f.name === "alpha/1x1.png");
    expect(pngEntry?.size).toBe(png.length);
    expect(pngEntry?.crc).toBe(crc32(png) >>> 0);
    const manEntry = files.find((f) => f.name === "manifest.json");
    expect(manEntry?.size).toBe(Buffer.byteLength(manifestJson));
    expect(manEntry?.crc).toBe(crc32(Buffer.from(manifestJson)) >>> 0);
    expect(buf.readUInt16LE(8)).toBe(0); // local header compression method = store
    // The bytes between the first local header and the next entry are the file itself.
    const firstNameLen = buf.readUInt16LE(26);
    expect(buf.subarray(30 + firstNameLen, 30 + firstNameLen + png.length)).toEqual(png);
  });

  test("skips a symlinked file inside the platform dir when walking for the zip", async () => {
    // Dirent.isFile()/isDirectory() (from readdir's withFileTypes) already report false for a
    // symlink entry, so collectEntries's `else if (entry.isFile())` naturally excludes it —
    // pinned explicitly here so a future refactor of the walk cannot silently start following it.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    mkdirSync(resolve(dir, "packages/camp/instagram-feed"), { recursive: true });
    writeFileSync(resolve(dir, "packages/camp/instagram-feed/real.png"), png);
    symlinkSync(
      resolve(dir, "packages/camp/instagram-feed/real.png"),
      resolve(dir, "packages/camp/instagram-feed/alias.png"),
    );
    const res = await zipCall("camp", "instagram-feed.zip");
    expect(res.status).toBe(200);
    const buf = Buffer.from(await res.arrayBuffer());
    const files = parseCentralDirectory(buf);
    expect(files.map((f) => f.name).sort()).toEqual(["real.png"]);
  });

  test("returns 404 when the platform dir is a symlink pointing outside the output root", async () => {
    const outside = mkdtempSync(join(tmpdir(), "cf-zip-outside-"));
    try {
      writeFileSync(join(outside, "secret.png"), "DO-NOT-SERVE");
      mkdirSync(resolve(dir, "packages/camp"), { recursive: true });
      symlinkSync(outside, resolve(dir, "packages/camp/instagram-feed"));
      const res = await zipCall("camp", "instagram-feed.zip");
      expect(res.status).toBe(404);
      const body = await res.text();
      expect(JSON.parse(body)).toEqual({ error: "Not found" });
      expect(body).not.toContain("DO-NOT-SERVE");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("returns 409 when the platform folder is rewritten during the walk", async () => {
    // Packaging swaps the folder with rm + rename; a walk that started before the swap
    // sees ENOENT (or ENOTDIR) on descent. Simulate the pull-away on the first readdir.
    mkdirSync(resolve(dir, "packages/camp/instagram-feed"), { recursive: true });
    fsHook.readdir = async () => {
      throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
    };
    const res = await zipCall("camp", "instagram-feed.zip");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Package is being rewritten, retry" });

    fsHook.readdir = async () => {
      throw Object.assign(new Error("ENOTDIR: not a directory"), { code: "ENOTDIR" });
    };
    expect((await zipCall("camp", "instagram-feed.zip")).status).toBe(409);
  });

  test("rethrows a non-rewrite error from the walk", async () => {
    mkdirSync(resolve(dir, "packages/camp/instagram-feed"), { recursive: true });
    fsHook.readdir = async () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    };
    expect((await zipCall("camp", "instagram-feed.zip")).status).toBe(500);
    fsHook.readdir = async () => {
      throw "not-an-error";
    };
    expect((await zipCall("camp", "instagram-feed.zip")).status).toBe(500);
  });

  test("returns 404 when the platform directory is missing", async () => {
    mkdirSync(resolve(dir, "packages/camp"), { recursive: true });
    const res = await zipCall("camp", "instagram-feed.zip");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  test("returns 404 when the param does not end in .zip", async () => {
    const res = await zipCall("camp", "instagram-feed");
    expect(res.status).toBe(404);
  });

  test("returns 400 for an unsafe campaign or platform id", async () => {
    expect((await zipCall("Not_Valid", "instagram-feed.zip")).status).toBe(400);
    expect((await zipCall("camp", ".zip")).status).toBe(400);
    expect((await zipCall("camp", "Not_Valid.zip")).status).toBe(400);
  });

  test("returns 404 when the platform path is a file", async () => {
    mkdirSync(resolve(dir, "packages/camp"), { recursive: true });
    writeFileSync(resolve(dir, "packages/camp/instagram-feed"), "not-a-dir");
    const res = await zipCall("camp", "instagram-feed.zip");
    expect(res.status).toBe(404);
  });

  test("zips an empty platform directory", async () => {
    mkdirSync(resolve(dir, "packages/camp/instagram-feed"), { recursive: true });
    const res = await zipCall("camp", "instagram-feed.zip");
    expect(res.status).toBe(200);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(parseCentralDirectory(buf)).toEqual([]);
  });
});

const collect = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

describe("store-zip", () => {
  test("measure folds chunks into the standard CRC-32 check vector", async () => {
    const { size, crc } = await measure(Readable.from([Buffer.from("1234"), Buffer.from("56789")]));
    expect(size).toBe(9);
    expect(crc).toBe(0xcbf43926);
    expect(crc).toBe(crc32("123456789") >>> 0);
  });

  test("storeZipStream emits header, bytes, central directory, and EOCD per entry", async () => {
    const data = Buffer.from("hello");
    const entries = [
      { name: "hello.txt", size: data.length, crc: crc32(data) >>> 0 },
      { name: "ünïcode/ø.txt", size: data.length, crc: crc32(data) >>> 0 },
    ];
    const zip = await collect(storeZipStream(entries, () => Readable.from([data])));
    expect(parseCentralDirectory(zip)).toEqual(entries);
  });

  test("never emits a zero-length chunk (empty directory, empty file)", async () => {
    const chunks: Buffer[] = [];
    for await (const c of storeZipStream([], () => Readable.from([]))) chunks.push(c as Buffer);
    const empty = { name: "e.txt", size: 0, crc: 0 };
    for await (const c of storeZipStream([empty], () => Readable.from([Buffer.alloc(0)])))
      chunks.push(c as Buffer);
    expect(chunks.every((c) => c.length > 0)).toBe(true);
  });

  test("storeZipStream of no entries is just an empty central directory", async () => {
    const zip = await collect(storeZipStream([], () => Readable.from([])));
    expect(zip.length).toBe(22);
    expect(parseCentralDirectory(zip)).toEqual([]);
  });
});

/**
 * PT-9a2, D233 r2 — the tombstone filter PT-9a1 shipped, through the packages
 * listing's own `campaignVisibility` gate.
 *
 * **Postgres only, in THIS file rather than the sibling `packages.s3.test.ts`**:
 * the tombstone lives on the `campaign` row, so it is the brief store's filter
 * under test and the object store is beside the point. This file is fs-object
 * store, which is what the gate runs in front of anyway — and the manifest is
 * planted under the pg harness's own output root, so the listing is a real 200
 * first and a 404 only after the tombstone.
 *
 * The file-wide `node:fs/promises` mock above does not touch this case: the
 * mock only replaces `readdir`, and delegating to the real one is what the fs
 * output store already does.
 */
describe("GET /campaigns/packages/:campaignId and a tombstone (PT-9a2, D233 r2)", () => {
  // fs, explicitly: these tests plant filesystem fixtures, and an inherited
  // OBJECT_STORE=s3 would point the route at unseeded object storage (Qodo on #682).
  const SAVED_OBJECT_STORE = process.env.OBJECT_STORE;
  beforeEach(() => {
    delete process.env.OBJECT_STORE;
  });
  afterEach(() => {
    if (SAVED_OBJECT_STORE === undefined) delete process.env.OBJECT_STORE;
    else process.env.OBJECT_STORE = SAVED_OBJECT_STORE;
  });

  const sampleBrief = (id: string): CampaignBrief => ({
    schemaVersion: BRIEF_SCHEMA_VERSION,
    template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
    id,
    targetRegion: "US",
    targetAudience: "developers",
    campaignMessage: "Build faster",
    products: [{ id: "p1", name: "P1", primaryColor: "#1473E6", logoPath: "logo.png" }],
  });

  test("a tombstoned campaign's package listing answers 404", async () => {
    const harness: PgHarness = await setupPgHarness();
    try {
      const store = getBriefStore(LOCAL_TENANT);
      await store.createCampaign("gone-camp");
      await store.createBrief(sampleBrief("gone-camp"));
      const platform = join(harness.outputRoot, "packages", "gone-camp", "instagram-feed");
      mkdirSync(platform, { recursive: true });
      writeFileSync(
        join(platform, "manifest.json"),
        JSON.stringify({ ...manifest("instagram-feed"), campaignId: "gone-camp" }),
      );

      // Served before the tombstone: a 404 below must be the gate, not a
      // campaign whose packages were never written.
      const before = await listCall("gone-camp");
      expect(before.status).toBe(200);
      const listed = (await before.json()) as { platforms: { platformId: string }[] };
      expect(listed.platforms.map((entry) => entry.platformId)).toEqual(["instagram-feed"]);

      await harness.db.query(
        `update campaign set deleted_at = now() where org_id = $1 and slug = $2`,
        [LOCAL_TENANT.orgId, "gone-camp"],
      );

      const res = await listCall("gone-camp");
      expect(res.status).toBe(404);
      // The one body both a hidden and a package-less campaign answer, so the
      // refusal leaks nothing about either.
      expect(await res.json()).toEqual({ error: "No packages found" });
      // Still on disk: hidden, not purged — this is PT-9g's job, not this gate's.
      expect(existsSync(join(platform, "manifest.json"))).toBe(true);
    } finally {
      await harness.cleanup();
    }
  }, 15000);
});
