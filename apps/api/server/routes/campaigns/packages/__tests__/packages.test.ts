import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { crc32 } from "node:zlib";
import { createApp, createRouter, toWebHandler, type EventHandler } from "h3";
import listHandler from "../[campaignId].get.js";
import zipHandler from "../[campaignId]/[platformZip].get.js";
import { buildStoreZip } from "../store-zip.js";

const web = (method: "get", path: string, handler: EventHandler) => {
  const app = createApp();
  const router = createRouter();
  router.get(path, handler);
  app.use(router);
  return toWebHandler(app);
};

const listCall = (campaignId: string) =>
  web("get", "/campaigns/packages/:campaignId", listHandler)(
    new Request(`http://x/campaigns/packages/${campaignId}`),
  );

const zipCall = (campaignId: string, platformZip: string) =>
  web("get", "/campaigns/packages/:campaignId/:platformZip", zipHandler)(
    new Request(`http://x/campaigns/packages/${campaignId}/${platformZip}`),
  );

function parseCentralDirectory(buf: Buffer): Array<{ name: string; size: number; crc: number }> {
  const eocd = buf.subarray(buf.length - 22);
  expect(eocd.readUInt32LE(0)).toBe(0x06054b50);
  const entries = eocd.readUInt16LE(10);
  const cdSize = eocd.readUInt32LE(12);
  const cdOffset = eocd.readUInt32LE(16);
  const cd = buf.subarray(cdOffset, cdOffset + cdSize);
  const files: Array<{ name: string; size: number; crc: number }> = [];
  let p = 0;
  for (let i = 0; i < entries; i++) {
    expect(cd.readUInt32LE(p)).toBe(0x02014b50);
    const crc = cd.readUInt32LE(p + 16);
    const size = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    files.push({ name, size, crc });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

let dir: string;
const origOut = process.env.OUTPUT_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cf-packages-"));
  process.env.OUTPUT_DIR = dir;
});
afterEach(() => {
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
    writeFileSync(resolve(dir, "packages/camp/instagram-feed/manifest.json"), JSON.stringify(manifest("instagram-feed")));
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
});

describe("GET /campaigns/packages/:campaignId/:platformId.zip", () => {
  test("streams a store-only zip whose central directory matches the files", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const manifestJson = JSON.stringify(manifest("instagram-feed"));
    mkdirSync(resolve(dir, "packages/camp/instagram-feed/alpha"), { recursive: true });
    writeFileSync(resolve(dir, "packages/camp/instagram-feed/manifest.json"), manifestJson);
    writeFileSync(resolve(dir, "packages/camp/instagram-feed/alpha/1x1.png"), png);
    symlinkSync(resolve(dir, "packages/camp/instagram-feed/manifest.json"), resolve(dir, "packages/camp/instagram-feed/link"));
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

describe("buildStoreZip", () => {
  test("encodes a single file", () => {
    const data = Buffer.from("hello");
    const zip = buildStoreZip([{ name: "hello.txt", data }]);
    expect(parseCentralDirectory(zip)).toEqual([
      { name: "hello.txt", size: 5, crc: crc32(data) >>> 0 },
    ]);
  });
});
