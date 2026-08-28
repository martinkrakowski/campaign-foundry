import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsAssetStore } from "../fs-asset-store.js";

const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

describe("FsAssetStore", () => {
  let dir: string;
  let store: FsAssetStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cf-fs-asset-store-"));
    store = new FsAssetStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("getBaseDir returns base directory", () => {
    expect(store.getBaseDir()).toBe(dir);
  });

  test("assetRelPath formats repo-relative path", () => {
    expect(store.assetRelPath("camp-1", "logo.png")).toBe("assets/inputs/camp-1/logo.png");
  });

  test("writeAsset writes asset file exclusively and returns relative path", async () => {
    const res = await store.writeAsset("camp-1", "brand-logo.png", pngBytes);
    expect(res.path).toBe("assets/inputs/camp-1/brand-logo.png");

    const saved = readFileSync(join(dir, "camp-1", "brand-logo.png"));
    expect(saved).toEqual(pngBytes);

    // Duplicate write fails with EEXIST
    await expect(store.writeAsset("camp-1", "brand-logo.png", pngBytes)).rejects.toMatchObject({
      code: "EEXIST",
    });
  });

  test("readAsset reads asset bytes or returns undefined on missing", async () => {
    await store.writeAsset("camp-1", "logo.png", pngBytes);
    expect(await store.readAsset("camp-1", "logo.png")).toEqual(pngBytes);
    expect(await store.readAsset("camp-1", "missing.png")).toBeUndefined();
    expect(await store.readAsset("../invalid-id", "logo.png")).toBeUndefined();
  });

  test("listAssets returns empty array for non-existent brief directory or invalid briefId", async () => {
    expect(await store.listAssets("non-existent-brief")).toEqual([]);
    expect(await store.listAssets("../invalid-escape")).toEqual([]);
  });

  test("listAssets lists, formats MIME type, size, and fetchable thumbnail URL for valid assets", async () => {
    await store.writeAsset("camp-1", "logo-b.png", pngBytes);
    await store.writeAsset("camp-1", "hero-a.jpg", jpegBytes);
    // Non-matching file should be ignored
    writeFileSync(join(dir, "camp-1", "notes.txt"), "hello");

    const list = await store.listAssets("camp-1");
    expect(list).toHaveLength(2);
    // Sorted by name: hero-a.jpg first, then logo-b.png
    expect(list[0].name).toBe("hero-a.jpg");
    expect(list[0].type).toBe("image/jpeg");
    expect(list[0].size).toBe(jpegBytes.length);
    expect(list[0].thumbnailUrl).toBe("/api/pipeline/campaigns/assets?briefId=camp-1&name=hero-a.jpg");

    expect(list[1].name).toBe("logo-b.png");
    expect(list[1].type).toBe("image/png");
    expect(list[1].size).toBe(pngBytes.length);
    expect(list[1].thumbnailUrl).toBe("/api/pipeline/campaigns/assets?briefId=camp-1&name=logo-b.png");
  });


  test("copyAssets copies all brief assets from source to destination including nested files", async () => {
    await store.writeAsset("camp-src", "logo.png", pngBytes);
    await store.writeAsset("camp-src", "bg.jpg", jpegBytes);

    // Create a nested file in camp-src
    mkdirSync(join(dir, "camp-src", "sub", "dir"), { recursive: true });
    writeFileSync(join(dir, "camp-src", "sub", "dir", "nested.png"), pngBytes);

    const map = await store.copyAssets("camp-src", "camp-dst");

    expect(existsSync(join(dir, "camp-dst", "logo.png"))).toBe(true);
    expect(existsSync(join(dir, "camp-dst", "bg.jpg"))).toBe(true);
    expect(existsSync(join(dir, "camp-dst", "sub", "dir", "nested.png"))).toBe(true);
    expect(readFileSync(join(dir, "camp-dst", "logo.png"))).toEqual(pngBytes);
    expect(readFileSync(join(dir, "camp-dst", "bg.jpg"))).toEqual(jpegBytes);
    expect(readFileSync(join(dir, "camp-dst", "sub", "dir", "nested.png"))).toEqual(pngBytes);

    expect(map["logo.png"]).toBe("logo.png");
    expect(map["sub/dir/nested.png"]).toBe("sub/dir/nested.png");
    expect(map["assets/inputs/camp-src/sub/dir/nested.png"]).toBe("assets/inputs/camp-dst/sub/dir/nested.png");
  });

  test("copyAssets disambiguates same-name assets with differing content from multiple sources", async () => {
    const diffPngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x99, 0x88, 0x77]);
    await store.writeAsset("src-a", "logo.png", pngBytes);
    await store.writeAsset("src-b", "logo.png", diffPngBytes);

    const mapA = await store.copyAssets("src-a", "target");
    const mapB = await store.copyAssets("src-b", "target");

    expect(mapA["logo.png"]).toBe("logo.png");
    expect(mapB["logo.png"]).toBe("logo-src-b.png");

    expect(readFileSync(join(dir, "target", "logo.png"))).toEqual(pngBytes);
    expect(readFileSync(join(dir, "target", "logo-src-b.png"))).toEqual(diffPngBytes);

    // If copying same bytes again, does not create duplicate
    const mapC = await store.copyAssets("src-a", "target");
    expect(mapC["logo.png"]).toBe("logo.png");

    // Pre-populate target to exercise candidate collision loop and candidate reuse
    const diffPngBytes2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x11, 0x22, 0x33]);
    await store.writeAsset("src-c", "logo.png", diffPngBytes2);
    await store.writeAsset("target", "logo-src-c.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xaa, 0xbb, 0xcc]));
    const mapD = await store.copyAssets("src-c", "target");
    expect(mapD["logo.png"]).toBe("logo-src-c-2.png");
    expect(readFileSync(join(dir, "target", "logo-src-c-2.png"))).toEqual(diffPngBytes2);

    // If copying src-c again with identical bytes, it matches existing candidate bytes and reuses logo-src-c-2.png
    const mapE = await store.copyAssets("src-c", "target");
    expect(mapE["logo.png"]).toBe("logo-src-c-2.png");

    // Nested directory collision disambiguation
    mkdirSync(join(dir, "src-nested-a", "sub", "dir"), { recursive: true });
    mkdirSync(join(dir, "src-nested-b", "sub", "dir"), { recursive: true });
    mkdirSync(join(dir, "target", "sub", "dir"), { recursive: true });
    writeFileSync(join(dir, "src-nested-a", "sub", "dir", "icon.png"), pngBytes);
    writeFileSync(join(dir, "src-nested-b", "sub", "dir", "icon.png"), diffPngBytes);
    writeFileSync(join(dir, "target", "sub", "dir", "icon-src-nested-b.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x99]));

    const mapNestA = await store.copyAssets("src-nested-a", "target");
    const mapNestB = await store.copyAssets("src-nested-b", "target");
    expect(mapNestA["sub/dir/icon.png"]).toBe("sub/dir/icon.png");
    expect(mapNestB["sub/dir/icon.png"]).toBe("sub/dir/icon-src-nested-b-2.png");
    expect(readFileSync(join(dir, "target", "sub", "dir", "icon-src-nested-b-2.png"))).toEqual(diffPngBytes);
  });

  test("copyAssets handles same source and destination, missing source, or empty source gracefully", async () => {
    expect(await store.copyAssets("same-id", "same-id")).toEqual({}); // No-op
    expect(await store.copyAssets("missing-src", "dst")).toEqual({}); // No-op
    expect(await store.copyAssets("../invalid-src", "dst")).toEqual({}); // No-op

    mkdirSync(join(dir, "empty-src"), { recursive: true });
    expect(await store.copyAssets("empty-src", "dst")).toEqual({});
    expect(existsSync(join(dir, "dst"))).toBe(false);
  });
});
