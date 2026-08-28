import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
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

  test("listAssets returns empty array for non-existent brief directory or invalid briefId", async () => {
    expect(await store.listAssets("non-existent-brief")).toEqual([]);
    expect(await store.listAssets("../invalid-escape")).toEqual([]);
  });

  test("listAssets lists, formats MIME type, size, and data URI thumbnail for valid assets", async () => {
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
    expect(list[0].thumbnailUrl).toBe(`data:image/jpeg;base64,${jpegBytes.toString("base64")}`);

    expect(list[1].name).toBe("logo-b.png");
    expect(list[1].type).toBe("image/png");
    expect(list[1].size).toBe(pngBytes.length);
    expect(list[1].thumbnailUrl).toBe(`data:image/png;base64,${pngBytes.toString("base64")}`);
  });

  test("listAssets skips files that fail stat or readFile", async () => {
    await store.writeAsset("camp-err", "logo.png", pngBytes);
    const filePath = join(dir, "camp-err", "logo.png");
    try {
      chmodSync(filePath, 0o000);
      const list = await store.listAssets("camp-err");
      expect(list).toEqual([]);
    } finally {
      chmodSync(filePath, 0o644);
    }
  });

  test("copyAssets copies all brief assets from source to destination", async () => {
    await store.writeAsset("camp-src", "logo.png", pngBytes);
    await store.writeAsset("camp-src", "bg.jpg", jpegBytes);

    await store.copyAssets("camp-src", "camp-dst");

    expect(existsSync(join(dir, "camp-dst", "logo.png"))).toBe(true);
    expect(existsSync(join(dir, "camp-dst", "bg.jpg"))).toBe(true);
    expect(readFileSync(join(dir, "camp-dst", "logo.png"))).toEqual(pngBytes);
    expect(readFileSync(join(dir, "camp-dst", "bg.jpg"))).toEqual(jpegBytes);
  });

  test("copyAssets handles same source and destination, missing source, or empty source gracefully", async () => {
    await store.copyAssets("same-id", "same-id"); // No-op
    await store.copyAssets("missing-src", "dst"); // No-op
    await store.copyAssets("../invalid-src", "dst"); // No-op

    mkdirSync(join(dir, "empty-src"), { recursive: true });
    await store.copyAssets("empty-src", "dst");
    expect(existsSync(join(dir, "dst"))).toBe(false);
  });
});
