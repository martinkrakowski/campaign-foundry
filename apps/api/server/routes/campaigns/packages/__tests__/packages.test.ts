import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { crc32 } from "node:zlib";
import { createApp, createRouter, toWebHandler, type EventHandler } from "h3";
import listHandler from "../[campaignId].get.js";
import zipHandler from "../[campaignId]/[platformZip].get.js";
import { Readable } from "node:stream";
import { measure, storeZipStream } from "../store-zip.js";

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
      fsHook.readdir ? fsHook.readdir(path) : (actual.readdir as (p: string, o?: unknown) => Promise<unknown>)(path, options),
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
  web("get", "/campaigns/packages/:campaignId", listHandler)(
    new Request(`http://x/campaigns/packages/${campaignId}`),
  );

const zipCall = (campaignId: string, platformZip: string) =>
  web("get", "/campaigns/packages/:campaignId/:platformZip", zipHandler)(
    new Request(`http://x/campaigns/packages/${campaignId}/${platformZip}`),
  );

const DOS_DATE_1980_01_01 = 0x0021;

/**
 * Walk the central directory and, for each entry, check that its offset points at a
 * local header for the same file (signature, UTF-8 flag, store method, DOS date, CRC).
 */
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
    expect(cd.readUInt16LE(p + 8)).toBe(0x0800); // UTF-8 names
    expect(cd.readUInt16LE(p + 10)).toBe(0); // store
    expect(cd.readUInt16LE(p + 14)).toBe(DOS_DATE_1980_01_01);
    const crc = cd.readUInt32LE(p + 16);
    const size = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const localOffset = cd.readUInt32LE(p + 42);
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    // The local header at the recorded offset must describe the same file.
    expect(buf.readUInt32LE(localOffset)).toBe(0x04034b50);
    expect(buf.readUInt16LE(localOffset + 6)).toBe(0x0800);
    expect(buf.readUInt16LE(localOffset + 8)).toBe(0);
    expect(buf.readUInt16LE(localOffset + 12)).toBe(DOS_DATE_1980_01_01);
    expect(buf.readUInt32LE(localOffset + 14)).toBe(crc);
    expect(buf.readUInt32LE(localOffset + 22)).toBe(size);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    expect(buf.subarray(localOffset + 30, localOffset + 30 + localNameLen).toString("utf8")).toBe(name);
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
    // The bytes between the first local header and the next entry are the file itself.
    const firstNameLen = buf.readUInt16LE(26);
    expect(buf.subarray(30 + firstNameLen, 30 + firstNameLen + png.length)).toEqual(png);
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

  test("storeZipStream of no entries is just an empty central directory", async () => {
    const zip = await collect(storeZipStream([], () => Readable.from([])));
    expect(zip.length).toBe(22);
    expect(parseCentralDirectory(zip)).toEqual([]);
  });
});
