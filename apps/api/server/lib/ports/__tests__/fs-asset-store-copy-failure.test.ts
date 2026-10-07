import { describe, beforeEach, afterEach, test, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsAssetStore } from "../fs-asset-store.js";

/**
 * `copyAssets` on a PARTIAL COPY FAILURE (PT-9j0): when the body throws part-way
 * through, the wrapper frees exactly what THIS call created before rethrowing
 * the original error. Offline: a temp directory, no database and no S3.
 */

const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const mp3Bytes = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x22]);
const m4aBytes = Buffer.from([
  0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 0x00, 0x00, 0x02, 0x00,
]);

const bytesByName: Record<string, Buffer> = {
  "png.png": pngBytes,
  "jpg.jpg": jpegBytes,
  "mp3.mp3": mp3Bytes,
};

/**
 * A path is in `created` from the moment its file exists (PT-9k2), so a `wx`
 * write that fails after the open is freed too: that case is pinned in
 * `fs-asset-store.test.ts` (`copyAssets frees a file whose write failed after the
 * exclusive open`), which plants the failure through the `node:fs/promises` mock.
 */

describe("FsAssetStore.copyAssets frees on failure (PT-9j0)", () => {
  let dir: string;
  let store: FsAssetStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cf-fs-copy-failure-"));
    store = new FsAssetStore(dir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  test("copyAssets removes the files it wrote when a later file fails and rethrows the original error", async () => {
    // Source "src" with three files of distinct bytes.
    await store.writeAsset("src", "png.png", pngBytes);
    await store.writeAsset("src", "jpg.jpg", jpegBytes);
    await store.writeAsset("src", "mp3.mp3", mp3Bytes);

    // collectFiles uses raw readdir order, so block the LAST file's destination
    // with a directory, making readFile fail with EISDIR.
    const order = readdirSync(join(dir, "src"));
    mkdirSync(join(dir, "dst", order.at(-1)!), { recursive: true });

    const freeSpy = vi.spyOn(FsAssetStore.prototype, "freeUnreferencedAssets");

    await expect(store.copyAssets("src", "dst")).rejects.toMatchObject({ code: "EISDIR" });

    // Neither order[0] nor order[1] exists as a FILE under dst (only the blocking
    // directory is there).
    expect(existsSync(join(dir, "dst", order[0]!))).toBe(false);
    expect(existsSync(join(dir, "dst", order[1]!))).toBe(false);

    // The source's three files are still there.
    expect(existsSync(join(dir, "src", "png.png"))).toBe(true);
    expect(existsSync(join(dir, "src", "jpg.jpg"))).toBe(true);
    expect(existsSync(join(dir, "src", "mp3.mp3"))).toBe(true);

    // The free spy was called once with ("dst", ids) and the sorted ids equal
    // [order[0], order[1]].sort().
    expect(freeSpy).toHaveBeenCalledTimes(1);
    expect(freeSpy).toHaveBeenCalledWith("dst", expect.arrayContaining([expect.any(String)]));
    const ids = freeSpy.mock.calls[0]![1] as string[];
    expect([...ids].sort()).toEqual([order[0]!, order[1]!].sort());
  });

  test("copyAssets never removes a reused file or a file the target already had when a later file fails", async () => {
    await store.writeAsset("src", "png.png", pngBytes);
    await store.writeAsset("src", "jpg.jpg", jpegBytes);
    await store.writeAsset("src", "mp3.mp3", mp3Bytes);

    const order = readdirSync(join(dir, "src"));
    mkdirSync(join(dir, "dst", order.at(-1)!), { recursive: true });

    // The target already holds order[0] with the SAME bytes as the source's (a REUSE)
    // and an unrelated mine.png.
    await store.writeAsset("dst", order[0]!, bytesByName[order[0]!]!);
    await store.writeAsset("dst", "mine.png", m4aBytes);

    const reusedPath = join(dir, "dst", order[0]!);
    const minePath = join(dir, "dst", "mine.png");

    const freeSpy = vi.spyOn(FsAssetStore.prototype, "freeUnreferencedAssets");

    await expect(store.copyAssets("src", "dst")).rejects.toMatchObject({ code: "EISDIR" });

    // Both are still there with their bytes; order[1] is gone.
    expect(existsSync(reusedPath)).toBe(true);
    expect(readFileSync(reusedPath)).toEqual(bytesByName[order[0]!]!);
    expect(existsSync(minePath)).toBe(true);
    expect(readFileSync(minePath)).toEqual(m4aBytes);
    expect(existsSync(join(dir, "dst", order[1]!))).toBe(false);

    // The free ids are exactly [order[1]].
    expect(freeSpy).toHaveBeenCalledTimes(1);
    const ids = freeSpy.mock.calls[0]![1] as string[];
    expect([...ids].sort()).toEqual([order[1]!].sort());
  });

  test("copyAssets rethrows the original error when removing its own files also fails", async () => {
    // As test 1 with vi.spyOn(FsAssetStore.prototype, "freeUnreferencedAssets").mockRejectedValueOnce(new Error("free failed"))
    await store.writeAsset("src", "png.png", pngBytes);
    await store.writeAsset("src", "jpg.jpg", jpegBytes);
    await store.writeAsset("src", "mp3.mp3", mp3Bytes);

    const order = readdirSync(join(dir, "src"));
    mkdirSync(join(dir, "dst", order.at(-1)!), { recursive: true });

    const freeSpy = vi
      .spyOn(FsAssetStore.prototype, "freeUnreferencedAssets")
      .mockRejectedValueOnce(new Error("free failed"));

    const result = store.copyAssets("src", "dst");

    await expect(result).rejects.toMatchObject({ code: "EISDIR" });
    // The free spy was called exactly once.
    expect(freeSpy).toHaveBeenCalledTimes(1);

    // The two files written before the EISDIR are still on disk (pinned leftover).
    expect(existsSync(join(dir, "dst", order[0]!))).toBe(true);
    expect(existsSync(join(dir, "dst", order[1]!))).toBe(true);
  });

  test("copyAssets returns its map and removes nothing when every file copies", async () => {
    await store.writeAsset("src", "png.png", pngBytes);
    await store.writeAsset("src", "jpg.jpg", jpegBytes);
    await store.writeAsset("src", "mp3.mp3", mp3Bytes);

    const freeSpy = vi.spyOn(FsAssetStore.prototype, "freeUnreferencedAssets");

    const { paths, created } = await store.copyAssets("src", "dst");

    // `paths` has 2 entries per asset: the bare name and the assets/inputs path.
    expect(Object.keys(paths)).toHaveLength(6);
    expect(Object.keys(paths).filter((k) => k.includes("assets/inputs/"))).toHaveLength(3);
    expect(created.size).toBe(3);
    expect(freeSpy).not.toHaveBeenCalled();

    // All three files exist in the destination.
    expect(existsSync(join(dir, "dst", "png.png"))).toBe(true);
    expect(existsSync(join(dir, "dst", "jpg.jpg"))).toBe(true);
    expect(existsSync(join(dir, "dst", "mp3.mp3"))).toBe(true);
  });
});
